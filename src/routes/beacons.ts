import { Router, Response } from 'express';
import logger from '../lib/logger';

const log = logger.child({ module: 'beacons' });
import { eq, and, desc, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { beacons, beaconMatches, userProfiles, users } from '../db/schema';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { CapabilityViolationError, getCapabilities } from '../middleware/capabilities';
import { enforceLimit, countOccupiedBeaconSlots, getOccupiedBeaconSlotInfo } from '../services/limitChecks';
import { analyzeBeacon } from '../services/claude';
import { logModerationEvent } from '../lib/moderationLog';
import { moderationEnforced } from '../lib/moderationEnforcement';

const router = Router();
router.use(requireAuth);

// ── Create a beacon ────────────────────────────────────────────────────────
const createBeaconSchema = z.object({
  rawText: z
    .string()
    .min(10, 'Beacon must be at least 10 characters')
    .max(280, 'Beacon must be under 280 characters')
    .trim(),
});

router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = createBeaconSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  const userId = req.user!.id;

  try {
    await enforceLimit(req, 'maxBeacons', countOccupiedBeaconSlots);
  } catch (err) {
    if (err instanceof CapabilityViolationError) {
      const max = err.max ?? 0;
      // A slot is freed only by expiry — surface when the next one opens so the
      // user doesn't try to delete-and-recreate (which no longer helps).
      const { nextFreesAt } = await getOccupiedBeaconSlotInfo(userId);
      res.status(403).json({
        error: max > 1
          ? `You're using all ${max} of your beacon slots. Deleting a beacon doesn't free a slot early — each slot opens when its beacon expires.`
          : `Free accounts get 1 beacon slot, and deleting a beacon doesn't free it early — the slot opens when the beacon expires. Upgrade to Premium for more.`,
        capabilityViolation: true,
        nextFreesAt,
      });
      return;
    }
    throw err;
  }

  // Get user's timezone from profile
  const profile = await db
    .select({ timezone: userProfiles.timezone })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);

  const timezone = profile[0]?.timezone ?? null;

  // Analyze with Claude (moderation + NLP parsing)
  let analysis;
  try {
    analysis = await analyzeBeacon(parse.data.rawText);
  } catch (err) {
    log.error({ err }, 'Claude analysis failed');
    res.status(503).json({ error: 'Beacon analysis temporarily unavailable. Please try again.' });
    return;
  }

  if (!analysis.isAppropriate) {
    if (moderationEnforced()) {
      logModerationEvent({ surface: 'beacon', action: 'rejected', reason: analysis.flagReason, senderId: userId });
      res.status(422).json({
        error: 'Your beacon could not be posted',
        reason: analysis.flagReason ?? 'Content policy violation',
      });
      return;
    }
    // Shadow mode: log what we would have blocked, then continue creating the
    // beacon using the analyzed data.
    logModerationEvent({ surface: 'beacon', action: 'shadow_would_block', reason: analysis.flagReason, senderId: userId });
  }

  // Set expiry 30 days from now
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  const [beacon] = await db
    .insert(beacons)
    .values({
      userId,
      rawText: parse.data.rawText,
      parsedIntent: analysis.parsedIntent,
      keywords: JSON.stringify(analysis.keywords), // stored keywords for matching
      timezone,
      isActive: true,
      isSanitized: true,
      expiresAt,
    })
    .returning();

  res.status(201).json({
    beacon: {
      ...beacon,
      analysis: {
        parsedIntent: analysis.parsedIntent,
        category: analysis.category,
        intentType: analysis.intentType,
      },
    },
  });
});

// ── List current user's beacons ────────────────────────────────────────────
// Returns beacons that are still within their life OR expired no more than 7
// days ago (Phase 23: expired beacons linger for a one-week grace, then drop
// off). The `slots` block is the authoritative occupancy summary for the UI —
// `used` ignores deletion/match and is freed only by expiry.
router.get('/mine', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;

  const myBeacons = await db
    .select()
    .from(beacons)
    .where(
      and(
        eq(beacons.userId, userId),
        sql`COALESCE(${beacons.expiresAt}, ${beacons.createdAt} + INTERVAL '30 days') > NOW() - INTERVAL '7 days'`,
      ),
    )
    .orderBy(desc(beacons.createdAt));

  const caps = await getCapabilities(req);
  const { used, nextFreesAt } = await getOccupiedBeaconSlotInfo(userId);

  res.json({
    beacons: myBeacons,
    slots: { used, limit: caps.limits.maxBeacons, nextFreesAt },
  });
});

// ── Deactivate a beacon ────────────────────────────────────────────────────
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const beaconId = parseInt(req.params.id as string, 10);
  if (isNaN(beaconId)) { res.status(400).json({ error: 'Invalid ID' }); return; }

  const [updated] = await db
    .update(beacons)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(beacons.id, beaconId), eq(beacons.userId, userId)))
    .returning();

  if (!updated) {
    res.status(404).json({ error: 'Beacon not found' });
    return;
  }

  res.json({ ok: true });
});

// ── Edit a beacon ──────────────────────────────────────────────────────────
// A beacon can be edited freely while it is active, unmatched, and unexpired.
// Editing re-runs moderation/parsing (new keywords drive future matching) but
// NEVER touches createdAt/expiresAt — the 30-day clock keeps running (Phase 23).
// Once matched, edit is a one-way door (blocked here, hidden in the client).
router.put('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const beaconId = parseInt(req.params.id as string, 10);
  if (isNaN(beaconId)) { res.status(400).json({ error: 'Invalid ID' }); return; }

  const parse = createBeaconSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  const [existing] = await db
    .select()
    .from(beacons)
    .where(and(eq(beacons.id, beaconId), eq(beacons.userId, userId)))
    .limit(1);

  if (!existing) {
    res.status(404).json({ error: 'Beacon not found' });
    return;
  }

  // Editability gates — enforced server-side so the client can't bypass by
  // calling the API directly. NULL expiresAt → createdAt + 30 days (decision 7).
  const effectiveExpiry = existing.expiresAt
    ? new Date(existing.expiresAt)
    : existing.createdAt
      ? new Date(new Date(existing.createdAt).getTime() + 30 * 24 * 60 * 60 * 1000)
      : null;
  // A null effective-expiry (legacy row missing both timestamps) is treated as
  // expired — the same rows the occupancy/visibility SQL excludes — so the gate
  // stays consistent with what the user can actually see and edit.
  if (!effectiveExpiry || effectiveExpiry.getTime() <= Date.now()) {
    res.status(409).json({ error: 'This beacon has expired and can no longer be edited.' });
    return;
  }
  if (existing.lastMatchedAt) {
    res.status(409).json({ error: "Matched beacons can't be edited." });
    return;
  }
  if (!existing.isActive) {
    res.status(409).json({ error: 'This beacon was removed and can no longer be edited.' });
    return;
  }

  // Re-analyze the new text. A failed moderation leaves the original untouched.
  let analysis;
  try {
    analysis = await analyzeBeacon(parse.data.rawText);
  } catch (err) {
    log.error({ err }, 'Claude analysis failed');
    res.status(503).json({ error: 'Beacon analysis temporarily unavailable. Please try again.' });
    return;
  }

  if (!analysis.isAppropriate) {
    if (moderationEnforced()) {
      logModerationEvent({ surface: 'beacon', action: 'rejected', reason: analysis.flagReason, senderId: userId });
      res.status(422).json({
        error: 'Your beacon could not be updated',
        reason: analysis.flagReason ?? 'Content policy violation',
      });
      return;
    }
    // Shadow mode: log what we would have blocked, then continue updating the
    // beacon using the analyzed data.
    logModerationEvent({ surface: 'beacon', action: 'shadow_would_block', reason: analysis.flagReason, senderId: userId });
  }

  const [updated] = await db
    .update(beacons)
    .set({
      rawText: parse.data.rawText,
      parsedIntent: analysis.parsedIntent,
      keywords: JSON.stringify(analysis.keywords),
      isSanitized: true,
      updatedAt: new Date(),
      // createdAt + expiresAt intentionally NOT set — editing never resets time.
    })
    .where(and(eq(beacons.id, beaconId), eq(beacons.userId, userId)))
    .returning();

  res.json({
    beacon: {
      ...updated,
      analysis: {
        parsedIntent: analysis.parsedIntent,
        category: analysis.category,
        intentType: analysis.intentType,
      },
    },
  });
});

// ── Get beacon matches for the current user ────────────────────────────────
router.get('/matches', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;

  // Get all matches for beacons owned by this user
  const matches = await db
    .select({
      matchId: beaconMatches.id,
      beaconId: beaconMatches.beaconId,
      myBeaconText: beacons.rawText,
      matchedBeaconId: beaconMatches.matchedBeaconId,
      similarityScore: beaconMatches.similarityScore,
      matchReason: beaconMatches.matchReason,
      viewedAt: beaconMatches.viewedAt,
      createdAt: beaconMatches.createdAt,
    })
    .from(beaconMatches)
    .innerJoin(beacons, eq(beacons.id, beaconMatches.beaconId))
    .where(and(eq(beacons.userId, userId), isNull(beaconMatches.dismissedAt)))
    .orderBy(desc(beaconMatches.createdAt));

  // Enrich with matched user info
  const enriched = await Promise.all(
    matches.map(async (m) => {
      const [matchedBeacon] = await db
        .select({
          rawText: beacons.rawText,
          parsedIntent: beacons.parsedIntent,
          userId: beacons.userId,
          userName: users.name,
          userHandle: userProfiles.handle,
          userAvatar: userProfiles.avatarUrl,
        })
        .from(beacons)
        .leftJoin(users, eq(users.id, beacons.userId))
        .leftJoin(userProfiles, eq(userProfiles.userId, beacons.userId))
        .where(eq(beacons.id, m.matchedBeaconId))
        .limit(1);

      return { ...m, matchedUser: matchedBeacon ?? null };
    })
  );

  res.json({ matches: enriched });
});

// ── Mark match as viewed ───────────────────────────────────────────────────
router.put('/matches/:id/viewed', async (req: AuthRequest, res: Response): Promise<void> => {
  const matchId = parseInt(req.params.id as string);

  await db
    .update(beaconMatches)
    .set({ viewedAt: new Date() })
    .where(eq(beaconMatches.id, matchId));

  res.json({ ok: true });
});

// ── Dismiss a beacon match ─────────────────────────────────────────────────
router.put('/matches/:id/dismiss', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const matchId = parseInt(req.params.id as string);

  // Verify the match belongs to a beacon owned by the requesting user
  const [match] = await db
    .select({ id: beaconMatches.id })
    .from(beaconMatches)
    .innerJoin(beacons, eq(beacons.id, beaconMatches.beaconId))
    .where(and(eq(beaconMatches.id, matchId), eq(beacons.userId, userId)))
    .limit(1);

  if (!match) {
    res.status(404).json({ error: 'Match not found' });
    return;
  }

  await db
    .update(beaconMatches)
    .set({ dismissedAt: new Date() })
    .where(eq(beaconMatches.id, matchId));

  res.json({ ok: true });
});

export default router;
