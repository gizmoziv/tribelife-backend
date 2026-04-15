/**
 * Daily Beacon Matcher — runs every 24 hours
 *
 * For each timezone group:
 * 1. Fetch all active, sanitized beacons
 * 2. Compare beacon pairs using Claude Haiku (cost-efficient)
 * 3. Record new matches (score >= 0.65) and send push notifications
 */
import cron from 'node-cron';
import { eq, and, isNull, isNotNull, or, lt, sql } from 'drizzle-orm';
import logger from '../lib/logger';

const log = logger.child({ module: 'beacon-matcher' });
import { db } from '../db';
import { beacons, beaconMatches, userProfiles, notifications, blockedUsers } from '../db/schema';
import { compareBeacons } from '../services/claude';
import { sendPushToUser, shouldSendPush } from '../services/pushNotifications';

async function runBeaconMatching(): Promise<void> {
  log.info('Starting run');

  // Fetch all active, sanitized, non-expired beacons
  const activeBeacons = await db
    .select({
      id: beacons.id,
      userId: beacons.userId,
      rawText: beacons.rawText,
      parsedIntent: beacons.parsedIntent,
      keywords: beacons.keywords,      // stores JSON-serialized keywords array
      timezone: beacons.timezone,
    })
    .from(beacons)
    .where(
      and(
        eq(beacons.isActive, true),
        eq(beacons.isSanitized, true),
        or(
          isNull(beacons.expiresAt),
          sql`${beacons.expiresAt} > NOW()`
        )
      )
    );

  if (activeBeacons.length < 2) {
    log.info('Not enough active beacons to match, skipping');
    return;
  }

  // Load all block relationships into a Set for O(1) lookup
  const allBlocks = await db
    .select({ userId: blockedUsers.userId, blockedUserId: blockedUsers.blockedUserId })
    .from(blockedUsers);

  const blockedPairs = new Set<string>();
  for (const row of allBlocks) {
    blockedPairs.add(`${row.userId}:${row.blockedUserId}`);
  }

  // Group by timezone for locality-aware matching
  const byTimezone = new Map<string, typeof activeBeacons>();
  for (const beacon of activeBeacons) {
    const tz = beacon.timezone ?? 'UTC';
    if (!byTimezone.has(tz)) byTimezone.set(tz, []);
    byTimezone.get(tz)!.push(beacon);
  }

  let totalMatches = 0;
  let totalComparisons = 0;

  for (const [timezone, tzBeacons] of byTimezone) {
    log.info({ timezone, count: tzBeacons.length }, 'Processing timezone');

    // Compare every pair (O(n²) — acceptable at community scale, revisit with pgvector at 10k+ beacons)
    for (let i = 0; i < tzBeacons.length; i++) {
      for (let j = i + 1; j < tzBeacons.length; j++) {
        const a = tzBeacons[i];
        const b = tzBeacons[j];

        // Skip same user
        if (a.userId === b.userId) continue;

        // Skip pairs where either user has blocked the other
        if (
          blockedPairs.has(`${a.userId}:${b.userId}`) ||
          blockedPairs.has(`${b.userId}:${a.userId}`)
        ) continue;

        // Skip pairs that already have a match recorded today, or that either user dismissed
        const existingMatch = await db
          .select({ id: beaconMatches.id, dismissedAt: beaconMatches.dismissedAt })
          .from(beaconMatches)
          .where(
            and(
              or(
                and(eq(beaconMatches.beaconId, a.id), eq(beaconMatches.matchedBeaconId, b.id)),
                and(eq(beaconMatches.beaconId, b.id), eq(beaconMatches.matchedBeaconId, a.id))
              ),
              or(
                sql`${beaconMatches.createdAt} > NOW() - INTERVAL '24 hours'`,
                isNotNull(beaconMatches.dismissedAt)
              )
            )
          )
          .limit(1);

        if (existingMatch.length > 0) continue;

        totalComparisons++;

        const keywordsA: string[] = a.keywords ? JSON.parse(a.keywords) : [];
        const keywordsB: string[] = b.keywords ? JSON.parse(b.keywords) : [];

        let result;
        try {
          result = await compareBeacons(
            a.parsedIntent ?? a.rawText,
            keywordsA,
            b.parsedIntent ?? b.rawText,
            keywordsB
          );
        } catch (err) {
          log.error({ err }, 'Claude comparison error');
          continue;
        }

        if (result.isMatch) {
          totalMatches++;

          // Record match for both beacons (A → B and B → A so each user sees it)
          await db
            .insert(beaconMatches)
            .values([
              {
                beaconId: a.id,
                matchedBeaconId: b.id,
                similarityScore: String(parseFloat(result.score.toFixed(3))),
                matchReason: result.reason,
              },
              {
                beaconId: b.id,
                matchedBeaconId: a.id,
                similarityScore: String(parseFloat(result.score.toFixed(3))),
                matchReason: result.reason,
              },
            ])
            .onConflictDoNothing();

          // Create in-app notifications; capture ids so pushes can
          // reference them for auto-mark-as-read on tap.
          const insertedNotifs = await db.insert(notifications).values([
            {
              userId: a.userId,
              type: 'beacon_match',
              title: '✨ Beacon Match Found!',
              body: result.reason,
              data: { beaconId: a.id, matchedBeaconId: b.id, timezone },
            },
            {
              userId: b.userId,
              type: 'beacon_match',
              title: '✨ Beacon Match Found!',
              body: result.reason,
              data: { beaconId: b.id, matchedBeaconId: a.id, timezone },
            },
          ]).returning({ id: notifications.id, userId: notifications.userId });
          const notifA = insertedNotifs.find((n) => n.userId === a.userId)?.id;
          const notifB = insertedNotifs.find((n) => n.userId === b.userId)?.id;

          // Send push notifications
          const [profileA] = await db
            .select({ expoPushToken: userProfiles.expoPushToken })
            .from(userProfiles)
            .where(eq(userProfiles.userId, a.userId))
            .limit(1);

          const [profileB] = await db
            .select({ expoPushToken: userProfiles.expoPushToken })
            .from(userProfiles)
            .where(eq(userProfiles.userId, b.userId))
            .limit(1);

          const [sendA, sendB] = await Promise.all([
            shouldSendPush(a.userId, 'beacon_match'),
            shouldSendPush(b.userId, 'beacon_match'),
          ]);

          await Promise.all([
            sendA ? sendPushToUser(profileA?.expoPushToken, '✨ Beacon Match!', result.reason, {
              type: 'beacon_match',
              beaconId: a.id,
              notificationId: notifA,
            }, a.userId) : Promise.resolve(),
            sendB ? sendPushToUser(profileB?.expoPushToken, '✨ Beacon Match!', result.reason, {
              type: 'beacon_match',
              beaconId: b.id,
              notificationId: notifB,
            }, b.userId) : Promise.resolve(),
          ]);

          // Update lastMatchedAt
          await db
            .update(beacons)
            .set({ lastMatchedAt: new Date() })
            .where(or(eq(beacons.id, a.id), eq(beacons.id, b.id)));
        }
      }
    }
  }

  log.info({ comparisons: totalComparisons, matches: totalMatches }, 'Run complete');
}

export function startBeaconMatcherCron(): void {
  // Run daily at 6:00 AM UTC
  cron.schedule('0 6 * * *', async () => {
    try {
      await runBeaconMatching();
    } catch (err) {
      log.error({ err }, 'Cron job failed');
    }
  });

  log.info('Cron scheduled: daily at 06:00 UTC');
}

// Export for manual trigger (e.g. admin endpoint or testing)
export { runBeaconMatching };
