/**
 * Daily Beacon Matcher — runs every 24 hours
 *
 * For each timezone group:
 * 1. Fetch all active, sanitized beacons
 * 2. Compare beacon pairs using Claude Haiku (cost-efficient)
 * 3. Record new matches (score >= 0.65) and send push notifications
 */
import cron from 'node-cron';
import { eq, and, isNull, or, lt, sql } from 'drizzle-orm';
import { db } from '../db';
import { beacons, beaconMatches, userProfiles, notifications } from '../db/schema';
import { compareBeacons } from '../services/claude';
import { sendPushToUser } from '../services/pushNotifications';

async function runBeaconMatching(): Promise<void> {
  console.log(`[beacon-matcher] Starting run at ${new Date().toISOString()}`);

  // Fetch all active, sanitized, non-expired beacons
  const activeBeacons = await db
    .select({
      id: beacons.id,
      userId: beacons.userId,
      rawText: beacons.rawText,
      parsedIntent: beacons.parsedIntent,
      embedding: beacons.embedding,   // stores JSON-serialized keywords array
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
    console.log('[beacon-matcher] Not enough active beacons to match. Skipping.');
    return;
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
    console.log(`[beacon-matcher] Processing timezone ${timezone}: ${tzBeacons.length} beacons`);

    // Compare every pair (O(n²) — acceptable at community scale, revisit with pgvector at 10k+ beacons)
    for (let i = 0; i < tzBeacons.length; i++) {
      for (let j = i + 1; j < tzBeacons.length; j++) {
        const a = tzBeacons[i];
        const b = tzBeacons[j];

        // Skip same user
        if (a.userId === b.userId) continue;

        // Skip pairs that already have a match recorded today
        const existingMatch = await db
          .select({ id: beaconMatches.id })
          .from(beaconMatches)
          .where(
            and(
              or(
                and(eq(beaconMatches.beaconId, a.id), eq(beaconMatches.matchedBeaconId, b.id)),
                and(eq(beaconMatches.beaconId, b.id), eq(beaconMatches.matchedBeaconId, a.id))
              ),
              sql`${beaconMatches.createdAt} > NOW() - INTERVAL '24 hours'`
            )
          )
          .limit(1);

        if (existingMatch.length > 0) continue;

        totalComparisons++;

        const keywordsA: string[] = a.embedding ? JSON.parse(a.embedding) : [];
        const keywordsB: string[] = b.embedding ? JSON.parse(b.embedding) : [];

        let result;
        try {
          result = await compareBeacons(
            a.parsedIntent ?? a.rawText,
            keywordsA,
            b.parsedIntent ?? b.rawText,
            keywordsB
          );
        } catch (err) {
          console.error('[beacon-matcher] Claude comparison error', err);
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
                similarityScore: result.score.toFixed(3),
                matchReason: result.reason,
              },
              {
                beaconId: b.id,
                matchedBeaconId: a.id,
                similarityScore: result.score.toFixed(3),
                matchReason: result.reason,
              },
            ])
            .onConflictDoNothing();

          // Create in-app notifications
          await db.insert(notifications).values([
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
          ]);

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

          await Promise.all([
            sendPushToUser(profileA?.expoPushToken, '✨ Beacon Match!', result.reason, {
              type: 'beacon_match',
              beaconId: a.id,
            }),
            sendPushToUser(profileB?.expoPushToken, '✨ Beacon Match!', result.reason, {
              type: 'beacon_match',
              beaconId: b.id,
            }),
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

  console.log(
    `[beacon-matcher] Done. Comparisons: ${totalComparisons}, New matches: ${totalMatches}`
  );
}

export function startBeaconMatcherCron(): void {
  // Run daily at 6:00 AM UTC
  cron.schedule('0 6 * * *', async () => {
    try {
      await runBeaconMatching();
    } catch (err) {
      console.error('[beacon-matcher] Cron job failed:', err);
    }
  });

  console.log('[beacon-matcher] Cron scheduled: daily at 06:00 UTC');
}

// Export for manual trigger (e.g. admin endpoint or testing)
export { runBeaconMatching };
