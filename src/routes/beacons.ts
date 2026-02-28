import { Router, Response } from 'express';
import { eq, and, desc, count } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { beacons, beaconMatches, userProfiles, users } from '../db/schema';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { analyzeBeacon } from '../services/claude';

const router = Router();
router.use(requireAuth);

const FREE_BEACON_LIMIT = 1;
const PREMIUM_BEACON_LIMIT = 3;

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
  const isPremium = req.user!.isPremium;
  const limit = isPremium ? PREMIUM_BEACON_LIMIT : FREE_BEACON_LIMIT;

  // Count active beacons
  const [{ value: activeCount }] = await db
    .select({ value: count() })
    .from(beacons)
    .where(and(eq(beacons.userId, userId), eq(beacons.isActive, true)));

  if (Number(activeCount) >= limit) {
    res.status(403).json({
      error: isPremium
        ? `Premium accounts can run up to ${PREMIUM_BEACON_LIMIT} beacons at a time`
        : `Free accounts can run 1 beacon at a time. Upgrade to Premium for up to ${PREMIUM_BEACON_LIMIT} beacons.`,
      upgradeRequired: !isPremium,
    });
    return;
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
    console.error('[beacons] Claude analysis failed', err);
    res.status(503).json({ error: 'Beacon analysis temporarily unavailable. Please try again.' });
    return;
  }

  if (!analysis.isAppropriate) {
    res.status(422).json({
      error: 'Your beacon could not be posted',
      reason: analysis.flagReason ?? 'Content policy violation',
    });
    return;
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
      embedding: JSON.stringify(analysis.keywords), // stored keywords for matching
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
router.get('/mine', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;

  const myBeacons = await db
    .select()
    .from(beacons)
    .where(eq(beacons.userId, userId))
    .orderBy(desc(beacons.createdAt));

  res.json({ beacons: myBeacons });
});

// ── Deactivate a beacon ────────────────────────────────────────────────────
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const beaconId = parseInt(req.params.id);

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
    .where(eq(beacons.userId, userId))
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
  const matchId = parseInt(req.params.id);

  await db
    .update(beaconMatches)
    .set({ viewedAt: new Date() })
    .where(eq(beaconMatches.id, matchId));

  res.json({ ok: true });
});

export default router;
