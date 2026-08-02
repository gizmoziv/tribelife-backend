import { Router, Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { eq, or, ilike, sql, isNotNull, and, desc, asc, count, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { users, userProfiles, surveys, surveyVotes, accessRequests } from '../db/schema';
import { announceUserBlocked } from '../services/moderationAnnounce';
import logger from '../lib/logger';
import {
  classifyZoneResolution,
  getTimezoneZone,
} from '../config/timezoneZones';
import { getIO } from '../lib/socketRegistry';

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
    res
      .status(503)
      .json({ error: 'admin endpoints disabled (ADMIN_API_KEY unset)' });
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
router.get(
  '/users/lookup',
  async (req: Request, res: Response): Promise<void> => {
    const handle = (
      typeof req.query.handle === 'string' ? req.query.handle : ''
    )
      .trim()
      .replace(/^@/, '');
    const email = (
      typeof req.query.email === 'string' ? req.query.email : ''
    ).trim();
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
  },
);

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

router.post(
  '/users/ban',
  async (req: Request, res: Response): Promise<void> => {
    const parse = banSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.errors[0].message });
      return;
    }
    const { userId, reason, announce } = parse.data;

    const [updated] = await db
      .update(users)
      .set({
        bannedAt: new Date(),
        banReason: reason ?? null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning({
        id: users.id,
        email: users.email,
        bannedAt: users.bannedAt,
        banReason: users.banReason,
      });

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
  },
);

// ── Unban a user ───────────────────────────────────────────────────────────────
// POST /api/admin/users/unban  { userId }
const unbanSchema = z.object({ userId: z.number().int().positive() });

router.post(
  '/users/unban',
  async (req: Request, res: Response): Promise<void> => {
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
      .returning({
        id: users.id,
        email: users.email,
        bannedAt: users.bannedAt,
      });

    if (!updated) {
      res.status(404).json({ error: 'user not found' });
      return;
    }
    log.warn({ userId }, 'user unbanned');
    res.json({ ok: true, user: updated });
  },
);

// ── Grant staff role ──────────────────────────────────────────────────────────
// POST /api/admin/users/staff  { userId }
// Sets is_staff = true. Same ADMIN_API_KEY gate as ban/unban (inherited from
// router.use(requireAdmin)). Staff status grants pin rights in community rooms (D-03).
const staffSchema = z.object({ userId: z.number().int().positive() });

router.post(
  '/users/staff',
  async (req: Request, res: Response): Promise<void> => {
    const parse = staffSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.errors[0].message });
      return;
    }
    const { userId } = parse.data;

    const [updated] = await db
      .update(users)
      .set({ isStaff: true, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning({ id: users.id, email: users.email, isStaff: users.isStaff });

    if (!updated) {
      res.status(404).json({ error: 'user not found' });
      return;
    }
    log.warn({ userId }, 'user granted staff');
    res.json({ ok: true, user: updated });
  },
);

// ── Revoke staff role ─────────────────────────────────────────────────────────
// POST /api/admin/users/unstaff  { userId }
// Sets is_staff = false. Mirrors the grant endpoint exactly.
router.post(
  '/users/unstaff',
  async (req: Request, res: Response): Promise<void> => {
    const parse = staffSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.errors[0].message });
      return;
    }
    const { userId } = parse.data;

    const [updated] = await db
      .update(users)
      .set({ isStaff: false, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning({ id: users.id, email: users.email, isStaff: users.isStaff });

    if (!updated) {
      res.status(404).json({ error: 'user not found' });
      return;
    }
    log.warn({ userId }, 'user revoked staff');
    res.json({ ok: true, user: updated });
  },
);

// ── Timezone coverage report ───────────────────────────────────────────────
// GET /api/admin/timezone-coverage
// Returns every distinct user_profiles.timezone classified as explicit |
// offset_fallback | utc_fallback, with per-timezone user counts, the resolved
// slug, displayName, and a recommended action for degraded rows.
// Single read-only GROUP BY aggregate — no per-row queries, no writes.
// Gated by requireAdmin (x-admin-key) inherited from router.use(requireAdmin).
router.get(
  '/timezone-coverage',
  async (req: Request, res: Response): Promise<void> => {
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
          recommendedAction =
            'no named zone for this offset — add a named zone or accept utc';
        }

        if (kind === 'explicit') explicit += row.count;
        else if (kind === 'offset_fallback') offset_fallback += row.count;
        else utc_fallback += row.count;
        totalProfiles += row.count;

        return {
          timezone: iana,
          count: row.count,
          kind,
          slug,
          displayName,
          recommendedAction,
        };
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
  },
);

// ── GET /api/admin/survey/other-suggestions ────────────────────────────────
// Returns raw Other free-text suggestions for the active survey, joined to
// the submitter's handle. Operator-only — inherits requireAdmin from
// router.use(requireAdmin) above; missing/invalid x-admin-key → 401/503.
router.get(
  '/survey/other-suggestions',
  async (req: Request, res: Response): Promise<void> => {
    try {
      // Resolve the current non-archived survey (live or finished)
      const [activeSurvey] = await db
        .select({ id: surveys.id })
        .from(surveys)
        .where(inArray(surveys.status, ['live', 'finished']))
        // Live-first (mirror GET /survey): never surface a stale finished survey
        // over a new live one.
        .orderBy(sql`CASE WHEN ${surveys.status} = 'live' THEN 0 ELSE 1 END`, surveys.id)
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
  },
);

router.get('/presence', async (_req: Request, res: Response): Promise<void> => {
  const io = getIO();
  if (!io) {
    res.status(500).json({ error: 'Failed to fetch presence' });
    return;
  }
  const sockets = await io.fetchSockets(); // cluster-wide — NOT adapter.rooms (D-09)
  res.json({ liveUsers: sockets.length });
});

// ── ACCESS REQUESTS (Phase 34) ─────────────────────────────────────────────
// D-22: this list endpoint is added beyond the PRD's literal R6/R7 because
// Marketing-Hub Phase 10 is an admin *review* tab, and with approve/reject
// keyed by request id and no way to discover ids or see who is applying, that
// phase would be blocked the moment it starts. D-02 states the applicant's
// email is read via join, which only makes sense if a read endpoint exists.
//
// Security notes: this endpoint exposes applicant email addresses, so it must
// never gain a second mount point outside this requireAdmin-gated router.
// `limit` is hard-capped at 200 to bound the response (DoS mitigation).
const adminListQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'all']).optional().default('pending'),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

// GET /api/admin/access-requests?status=pending&limit=50&offset=0
router.get('/access-requests', async (req: Request, res: Response): Promise<void> => {
    const parse = adminListQuerySchema.safeParse(req.query);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.errors[0].message });
      return;
    }
    const { status, limit, offset } = parse.data;

    // Same filter variable feeds both the page query and the count query, so
    // they provably agree on which rows are in scope.
    const statusFilter =
      status === 'all' ? undefined : eq(accessRequests.status, status);

    const pageQuery = db
      .select({
        id: accessRequests.id,
        userId: accessRequests.userId,
        email: users.email,
        name: users.name,
        handle: userProfiles.handle,
        reason: accessRequests.reason,
        socials: accessRequests.socials,
        status: accessRequests.status,
        createdAt: accessRequests.createdAt,
        decidedAt: accessRequests.decidedAt,
        decidedBy: accessRequests.decidedBy,
      })
      .from(accessRequests)
      .innerJoin(users, eq(users.id, accessRequests.userId))
      // leftJoin so a request from a user without a profile row still appears
      // rather than silently vanishing from the admin queue.
      .leftJoin(userProfiles, eq(userProfiles.userId, accessRequests.userId))
      .orderBy(asc(accessRequests.createdAt)) // oldest pending first — FIFO review queue
      .limit(limit)
      .offset(offset);

    const rows = statusFilter
      ? await pageQuery.where(statusFilter)
      : await pageQuery;

    const countQuery = db
      .select({ total: count() })
      .from(accessRequests);

    const [countRow] = statusFilter
      ? await countQuery.where(statusFilter)
      : await countQuery;

    res.json({ accessRequests: rows, total: countRow?.total ?? 0 });
});

// D-12, D-13: approve and reject are symmetric decisions on the same request
// row, differing only by the target status literal. A single shared helper
// keeps them symmetric — two near-identical copy-pasted handlers are exactly
// how a later editor accidentally introduces asymmetric behavior and breaks
// D-15's reversibility.
const adminDecideSchema = z.object({
  adminLabel: z.string().max(100).optional(),
});

// D-14 — the hard rule, and the single most important semantic distinction in
// this phase. This helper (and the approve/reject routes below) must NEVER
// write, clear or even read the platform-suspension columns on `users` (the
// `bannedAt`/`banReason` pair the ban/unban handlers above operate on), must
// never call announceUserBlocked or any other moderation-announcement
// service, and must never delete anything. A rejected user keeps their
// account and all their data, can still authenticate, and is blocked only by
// the access gate — reject is emphatically not a ban.
async function decideAccessRequest(
  req: Request,
  res: Response,
  nextStatus: 'approved' | 'rejected',
): Promise<void> {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }

  const parse = adminDecideSchema.safeParse(req.body ?? {});
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  // No precondition on the current status — that absence is what makes the
  // transition reversible (D-15): approving a previously rejected request
  // works, and no one-way transition is built.
  const [updatedRequest] = await db.update(accessRequests)
    .set({
      status: nextStatus,
      decidedAt: new Date(),
      decidedBy: parse.data.adminLabel ?? null,
    })
    .where(eq(accessRequests.id, id))
    .returning({
      id: accessRequests.id,
      userId: accessRequests.userId,
      status: accessRequests.status,
      decidedAt: accessRequests.decidedAt,
      decidedBy: accessRequests.decidedBy,
    });

  if (!updatedRequest) {
    res.status(404).json({ error: 'access request not found' });
    return;
  }

  // Mirror the status onto the user (D-12, D-13). Both writes are required —
  // updating only access_requests would leave the user still gated despite an
  // approval, and updating only user_profiles would leave the admin queue
  // showing the request as undecided.
  await db.update(userProfiles)
    .set({ accessStatus: nextStatus, updatedAt: new Date() })
    .where(eq(userProfiles.userId, updatedRequest.userId));

  log.warn(
    { accessRequestId: id, userId: updatedRequest.userId, status: nextStatus },
    'access request decided',
  );

  res.json({ ok: true, accessRequest: updatedRequest });
}

// POST /api/admin/access-requests/:id/approve  { adminLabel?: string }
router.post('/access-requests/:id/approve', async (req: Request, res: Response): Promise<void> => {
  await decideAccessRequest(req, res, 'approved');
});

// POST /api/admin/access-requests/:id/reject  { adminLabel?: string }
// D-16: no email is sent by this backend — status flip only. Marketing-Hub
// owns applicant email via its own SendGrid access.
router.post('/access-requests/:id/reject', async (req: Request, res: Response): Promise<void> => {
  await decideAccessRequest(req, res, 'rejected');
});

export default router;
