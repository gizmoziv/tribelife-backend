import { Router, Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { eq, or, ilike, sql, isNotNull, and, desc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { users, userProfiles, surveys, surveyVotes } from '../db/schema';
import { announceUserBlocked } from '../services/moderationAnnounce';
import logger from '../lib/logger';
import { classifyZoneResolution, getTimezoneZone } from '../config/timezoneZones';

const log = logger.child({ module: 'admin' });
const router = Router();

// ── Admin authorization ─────────────────────────────────────────────────────
// Platform-level admin actions (e.g. banning a spammer) are gated by a shared
// secret in the `x-admin-key` header matched against process.env.ADMIN_API_KEY.
// There is no user-level "admin" role in the product, so a server secret is the
// simplest safe gate. If ADMIN_API_KEY is unset the whole router is disabled
// (503) — it can never be accidentally left open.
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) {
    res.status(503).json({ error: 'admin endpoints disabled (ADMIN_API_KEY unset)' });
    return;
  }
  const provided = req.header('x-admin-key') ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Constant-time compare; length guard avoids timingSafeEqual throwing on
  // mismatched buffer lengths (which would itself leak length info).
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

router.use(requireAdmin);

// ── Lookup a user (to find the id before banning) ─────────────────────────────
// GET /api/admin/users/lookup?handle=spammer   OR   ?email=foo@bar.com
// handle match is case-insensitive and ignores a leading '@'.
router.get('/users/lookup', async (req: Request, res: Response): Promise<void> => {
  const handle = (typeof req.query.handle === 'string' ? req.query.handle : '').trim().replace(/^@/, '');
  const email = (typeof req.query.email === 'string' ? req.query.email : '').trim();
  if (!handle && !email) {
    res.status(400).json({ error: 'provide handle or email' });
    return;
  }

  const conditions = [
    handle ? ilike(userProfiles.handle, handle) : undefined,
    email ? ilike(users.email, email) : undefined,
  ].filter(Boolean) as any[];

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      handle: userProfiles.handle,
      bannedAt: users.bannedAt,
      banReason: users.banReason,
      createdAt: users.createdAt,
    })
    .from(users)
    .leftJoin(userProfiles, eq(users.id, userProfiles.userId))
    .where(conditions.length === 1 ? conditions[0] : or(...conditions))
    .limit(25);

  res.json({ users: rows });
});

// ── Ban a user ────────────────────────────────────────────────────────────────
// POST /api/admin/users/ban  { userId, reason? }
// Sets banned_at — does NOT delete the account, so the unique google_id/apple_id
// stays claimed and the user cannot re-register or sign back in. requireAuth and
// the sign-in handlers reject banned users (403 account_suspended).
const banSchema = z.object({
  userId: z.number().int().positive(),
  reason: z.string().max(500).optional(),
  announce: z.boolean().optional(), // default true — drop "@handle was blocked" notices into their chats
});

router.post('/users/ban', async (req: Request, res: Response): Promise<void> => {
  const parse = banSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }
  const { userId, reason, announce } = parse.data;

  const [updated] = await db
    .update(users)
    .set({ bannedAt: new Date(), banReason: reason ?? null, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ id: users.id, email: users.email, bannedAt: users.bannedAt, banReason: users.banReason });

  if (!updated) {
    res.status(404).json({ error: 'user not found' });
    return;
  }
  log.warn({ userId, reason: reason ?? null }, 'user banned');

  // Drop a "@handle was blocked by our system" system message into every room +
  // conversation the user posted in (default on; pass announce:false to suppress).
  // Best-effort — never let an announcement failure fail the ban itself.
  let announced: { rooms: number; conversations: number } | null = null;
  if (announce !== false) {
    const [prof] = await db
      .select({ handle: userProfiles.handle })
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .limit(1);
    if (prof?.handle) {
      try {
        announced = await announceUserBlocked(userId, prof.handle);
      } catch (err) {
        log.error({ err, userId }, 'user banned but announcement failed');
      }
    }
  }

  res.json({ ok: true, user: updated, announced });
});

// ── Unban a user ───────────────────────────────────────────────────────────────
// POST /api/admin/users/unban  { userId }
const unbanSchema = z.object({ userId: z.number().int().positive() });

router.post('/users/unban', async (req: Request, res: Response): Promise<void> => {
  const parse = unbanSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }
  const { userId } = parse.data;

  const [updated] = await db
    .update(users)
    .set({ bannedAt: null, banReason: null, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ id: users.id, email: users.email, bannedAt: users.bannedAt });

  if (!updated) {
    res.status(404).json({ error: 'user not found' });
    return;
  }
  log.warn({ userId }, 'user unbanned');
  res.json({ ok: true, user: updated });
});

// ── Timezone coverage report ───────────────────────────────────────────────
// GET /api/admin/timezone-coverage
// Returns every distinct user_profiles.timezone classified as explicit |
// offset_fallback | utc_fallback, with per-timezone user counts, the resolved
// slug, displayName, and a recommended action for degraded rows.
// Single read-only GROUP BY aggregate — no per-row queries, no writes.
// Gated by requireAdmin (x-admin-key) inherited from router.use(requireAdmin).
router.get('/timezone-coverage', async (req: Request, res: Response): Promise<void> => {
  try {
    const rows = await db
      .select({
        timezone: userProfiles.timezone,
        count: sql<number>`count(*)::int`,
      })
      .from(userProfiles)
      .where(isNotNull(userProfiles.timezone))
      .groupBy(userProfiles.timezone);

    let explicit = 0;
    let offset_fallback = 0;
    let utc_fallback = 0;
    let totalProfiles = 0;

    const classified = rows.map((row) => {
      const iana = row.timezone as string;
      const { kind, slug } = classifyZoneResolution(iana);
      const displayName = getTimezoneZone(slug)?.displayName ?? null;

      let recommendedAction: string | null = null;
      if (kind === 'offset_fallback') {
        recommendedAction = `add to TIMEZONE_ZONES['${slug}'].members + backend deploy (closes push fan-out)`;
      } else if (kind === 'utc_fallback') {
        recommendedAction = 'no named zone for this offset — add a named zone or accept utc';
      }

      if (kind === 'explicit') explicit += row.count;
      else if (kind === 'offset_fallback') offset_fallback += row.count;
      else utc_fallback += row.count;
      totalProfiles += row.count;

      return { timezone: iana, count: row.count, kind, slug, displayName, recommendedAction };
    });

    // Sort by count desc (highest-traffic timezones first).
    classified.sort((a, b) => b.count - a.count);

    res.json({
      summary: {
        explicit,
        offset_fallback,
        utc_fallback,
        totalProfiles,
        distinctTimezones: rows.length,
      },
      rows: classified,
    });
  } catch (err) {
    log.error({ err }, 'timezone-coverage query failed');
    res.status(500).json({ error: 'failed to fetch timezone coverage' });
  }
});

// ── GET /api/admin/survey/other-suggestions ────────────────────────────────
// Returns raw Other free-text suggestions for the active survey, joined to
// the submitter's handle. Operator-only — inherits requireAdmin from
// router.use(requireAdmin) above; missing/invalid x-admin-key → 401/503.
router.get('/survey/other-suggestions', async (req: Request, res: Response): Promise<void> => {
  try {
    // Resolve the active survey
    const [activeSurvey] = await db
      .select({ id: surveys.id })
      .from(surveys)
      .where(eq(surveys.active, true))
      .orderBy(surveys.id)
      .limit(1);

    if (!activeSurvey) {
      res.json({ suggestions: [] });
      return;
    }

    // Select Other votes (non-null otherText) joined to userProfiles for handle
    const rows = await db
      .select({
        text: surveyVotes.otherText,
        handle: userProfiles.handle,
        userId: surveyVotes.userId,
        submittedAt: surveyVotes.createdAt,
      })
      .from(surveyVotes)
      .leftJoin(userProfiles, eq(surveyVotes.userId, userProfiles.userId))
      .where(
        and(
          eq(surveyVotes.surveyId, activeSurvey.id),
          isNotNull(surveyVotes.otherText),
        ),
      )
      .orderBy(desc(surveyVotes.createdAt));

    const suggestions = rows.map((r) => ({
      text: r.text!,
      handle: r.handle ?? null,
      userId: r.userId,
      submittedAt: r.submittedAt,
    }));

    res.json({ suggestions });
  } catch (err) {
    console.error('[admin/survey/other-suggestions]', err);
    res.status(500).json({ error: 'Failed to load suggestions' });
  }
});

export default router;
