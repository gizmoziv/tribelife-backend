/**
 * News push dispatch service.
 *
 * Post-enrichment sweep inside runNewsIngestion(). For each article with
 * importance='breaking' that has not yet been pushed (no row in
 * news_push_history) and is within the freshness window (publishedAt within
 * push_max_age_minutes), iterates eligible users (newsPushEnabled=true,
 * valid ExponentPushToken[ prefix, non-NULL IANA timezone) and applies four
 * gates in order before dispatching:
 *
 *   1. Quiet hours (22:00-07:00 user-local, configurable) — silent skip, NO history row
 *   2. Quota       (rolling 24h, default 3/user)          — silent skip, NO history row
 *   3. Cooldown    (45 min since last send, unbounded)    — silent skip, NO history row
 *   4. Freshness   (headline NULL guard)                  — skipped_stale++
 *
 * A row is inserted into news_push_history BEFORE the Expo HTTP call (D-03).
 * onConflictDoNothing() on UNIQUE(userId, articleId) guards against the
 * overlap-sweep race. If Expo fails after the row exists the user silently
 * misses one push — acceptable trade for never double-pushing.
 *
 * Envelopes are batched 100-at-a-time through the shared
 * sendPushNotifications() helper; per-batch failures increment expoErrors
 * and continue.
 *
 * Decisions: D-01, D-02, D-03, D-04, D-05, D-06, D-07, D-08, D-09, D-10,
 *            D-11, D-12.
 * Threats:   T-04-01 (token logging), T-04-02 (per-iteration envelope),
 *            T-04-03 (Intl throw), T-04-04 (history race), T-04-05 (Expo error).
 */

import { eq, and, gt, sql, max, isNotNull } from 'drizzle-orm';
import type { Logger } from 'pino';

import logger from '../../lib/logger';
import { db } from '../../db';
import {
  newsArticles,
  newsOutlets,
  userProfiles,
  newsPushHistory,
} from '../../db/schema';
import { getConfig } from './config';
import {
  sendPushNotifications,
  getUnreadBadgeCounts,
} from '../pushNotifications';

// ── Module-level log (not used inside dispatchBreakingPushes — parent child log preferred) ──
// Kept so callers that want a detached log (future manual admin trigger) have one.
const log = logger.child({ module: 'news-push-dispatch' });
void log; // silence "declared but never read" without stripping the pattern

// ── Export: aggregate stats shape ────────────────────────────
export type DispatchStats = {
  eligible: number;        // candidate (user, article) pairs BEFORE any gate
  sent: number;            // envelopes successfully delivered via Expo (per-batch granularity)
  skippedQuiet: number;    // dropped by quiet-hours gate — no history row
  skippedCooldown: number; // dropped by 45-min cooldown gate — no history row
  skippedQuota: number;    // dropped by rolling-24h quota gate — no history row
  skippedStale: number;    // dropped because headline is NULL (D-11 fallback guard)
  expoErrors: number;      // batches that threw on sendPushNotifications()
};

// ── Export: quiet-hours helper (testable) ────────────────────────────
/**
 * Returns true if `now` falls inside the user-local quiet-hours window
 * [quietStart, quietEnd). Handles overnight windows (quietStart > quietEnd).
 *
 * Conservative-skip behavior on malformed timezone (T-04-03): any throw
 * from Intl.DateTimeFormat (RangeError on invalid IANA string, etc.) causes
 * this function to return true — the caller will silently skip the user.
 * Pairs with D-07: timezone IS NULL users are already filtered upstream.
 */
export function isWithinQuietHours(
  timezone: string,
  quietStart: number,
  quietEnd: number,
  now: Date = new Date(),
): boolean {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(now);
    const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
    // Overnight window (e.g. 22 → 07 spans midnight)
    if (quietStart > quietEnd) return hour >= quietStart || hour < quietEnd;
    // Same-day window
    return hour >= quietStart && hour < quietEnd;
  } catch {
    return true; // D-07 / T-04-03 — conservative skip on invalid IANA string
  }
}

// ── Export: main sweep ────────────────────────────
export async function dispatchBreakingPushes(
  parentLog: Logger,
): Promise<DispatchStats> {
  const pushLog = parentLog.child({ module: 'news-push-dispatch' });

  const stats: DispatchStats = {
    eligible: 0,
    sent: 0,
    skippedQuiet: 0,
    skippedCooldown: 0,
    skippedQuota: 0,
    skippedStale: 0,
    expoErrors: 0,
  };

  // Config reads — all 5 keys from news_config (60s TTL cache in getConfig).
  // Defaults match the seeds in Phase 1 D-09 + Phase 4 D-08.
  const dailyPushQuota  = await getConfig<number>('daily_push_quota',      3);
  const cooldownMinutes = await getConfig<number>('push_cooldown_minutes', 45);
  const quietStart      = await getConfig<number>('quiet_hours_start',     22);
  const quietEnd        = await getConfig<number>('quiet_hours_end',        7);
  const maxAgeMinutes   = await getConfig<number>('push_max_age_minutes',  60);

  // ── Article selection ──────────────────────────────────────
  // D-01: breaking articles not yet pushed. D-08: within freshness window.
  // Pitfall 3: filter on publishedAt (publisher-time), NOT createdAt (DB-insert-time).
  // sql.raw interval is safe because maxAgeMinutes comes from validated
  // getConfig<number>() — no injection risk.
  const articles = await db
    .select({
      id: newsArticles.id,
      translatedTitle: newsArticles.translatedTitle,
      rephrasedTitle: newsArticles.rephrasedTitle,
      publishedAt: newsArticles.publishedAt,
      outletName: newsOutlets.name,
    })
    .from(newsArticles)
    .innerJoin(newsOutlets, eq(newsOutlets.id, newsArticles.outletId))
    .where(
      and(
        eq(newsArticles.importance, 'breaking'),
        sql`${newsArticles.id} NOT IN (SELECT article_id FROM news_push_history)`,
        gt(newsArticles.publishedAt, sql.raw(`NOW() - INTERVAL '${maxAgeMinutes} minutes'`)),
      ),
    );

  if (articles.length === 0) {
    pushLog.info({ ...stats }, 'Push dispatch sweep complete (no candidates)');
    return stats;
  }

  // ── Eligible users ─────────────────────────────────────────
  // D-02: newsPushEnabled=true, valid Expo token, non-NULL timezone.
  // The LIKE filter mirrors the internal prefix check inside
  // sendPushNotifications() so we don't even build envelopes for junk tokens.
  const eligibleUsers = await db
    .select({
      userId: userProfiles.userId,
      expoPushToken: userProfiles.expoPushToken,
      timezone: userProfiles.timezone,
    })
    .from(userProfiles)
    .where(
      and(
        eq(userProfiles.newsPushEnabled, true),
        isNotNull(userProfiles.expoPushToken),
        isNotNull(userProfiles.timezone),
        sql`${userProfiles.expoPushToken} LIKE 'ExponentPushToken[%'`,
      ),
    );

  stats.eligible = eligibleUsers.length * articles.length;

  // ── Pre-fetch badge counts (Pitfall 6 — batched, not per-user) ────
  const userIds = eligibleUsers.map((u) => u.userId);
  const badgeMap = userIds.length > 0
    ? await getUnreadBadgeCounts(userIds)
    : new Map<number, number>();

  // Collect envelopes across all (user, article) pairs that pass all gates;
  // batch-send at the end. Fresh object literal per iteration guards T-04-02.
  const envelopes: Array<{
    to: string;
    title: string;
    body: string;
    sound: 'default';
    channelId: string;
    data: { type: 'news_breaking'; articleId: number };
    badge: number;
  }> = [];

  for (const article of articles) {
    const articleLog = pushLog.child({ article_id: article.id });

    // D-11 null guard — if both titles are NULL the envelope body is
    // meaningless; count as stale for every eligible user so the aggregate
    // reflects the wasted candidates.
    const headline = article.translatedTitle ?? article.rephrasedTitle;
    if (!headline) {
      stats.skippedStale += eligibleUsers.length;
      articleLog.warn({}, 'article has no headline — skipping all users');
      continue;
    }

    for (const user of eligibleUsers) {
      try {
        // 1. Quiet hours (D-09) — silent skip, NO history row.
        if (isWithinQuietHours(user.timezone!, quietStart, quietEnd)) {
          stats.skippedQuiet++;
          continue;
        }

        // 2. Quota (D-06) — rolling 24h window, NO history row on overflow.
        const [quotaRow] = await db
          .select({ cnt24h: sql<number>`COUNT(*)::int` })
          .from(newsPushHistory)
          .where(
            and(
              eq(newsPushHistory.userId, user.userId),
              gt(newsPushHistory.sentAt, sql.raw(`NOW() - INTERVAL '24 hours'`)),
            ),
          );
        if ((quotaRow?.cnt24h ?? 0) >= dailyPushQuota) {
          stats.skippedQuota++;
          continue;
        }

        // 3. Cooldown (D-10) — unbounded MAX (not restricted to 24h so a
        //    user who hit quota yesterday still cools for 45m today).
        //    NO history row on active cooldown.
        const [cooldownRow] = await db
          .select({ lastSent: max(newsPushHistory.sentAt) })
          .from(newsPushHistory)
          .where(eq(newsPushHistory.userId, user.userId));
        const lastSent = cooldownRow?.lastSent;
        if (lastSent !== null && lastSent !== undefined) {
          const msSinceLast = Date.now() - new Date(lastSent).getTime();
          if (msSinceLast < cooldownMinutes * 60_000) {
            stats.skippedCooldown++;
            continue;
          }
        }

        // 4. INSERT news_push_history BEFORE the Expo send (D-03).
        //    UNIQUE(userId, articleId) + onConflictDoNothing() is the
        //    idempotency guard against overlapping sweeps (T-04-04).
        await db
          .insert(newsPushHistory)
          .values({ userId: user.userId, articleId: article.id })
          .onConflictDoNothing();

        // 5. Build envelope (D-12). Fresh literal per iteration — T-04-02.
        envelopes.push({
          to: user.expoPushToken!,
          title: 'Breaking',
          body: `${headline} — ${article.outletName}`,
          sound: 'default',
          channelId: 'news',
          data: { type: 'news_breaking', articleId: article.id },
          badge: badgeMap.get(user.userId) ?? 0,
        });
      } catch (err) {
        articleLog.warn(
          { err, user_id: user.userId },
          'user dispatch failed — skipping',
        );
        // continue to next user
      }
    }
  }

  // ── Batch Expo send, 100 at a time, sequential (D-04) ────────────
  for (let i = 0; i < envelopes.length; i += 100) {
    const chunk = envelopes.slice(i, i + 100);
    try {
      await sendPushNotifications(chunk);
      stats.sent += chunk.length;
      pushLog.info(
        { batch_size: chunk.length, batch_index: i },
        'batch sent',
      );
    } catch (err) {
      // T-04-05: internal error log only; no propagation to caller.
      pushLog.error(
        { err, batch_index: i, batch_size: chunk.length },
        'batch send failed — continuing',
      );
      stats.expoErrors++;
    }
  }

  pushLog.info(
    {
      eligible: stats.eligible,
      sent: stats.sent,
      skipped_quiet: stats.skippedQuiet,
      skipped_cooldown: stats.skippedCooldown,
      skipped_quota: stats.skippedQuota,
      skipped_stale: stats.skippedStale,
      expo_errors: stats.expoErrors,
    },
    'Push dispatch sweep complete',
  );
  return stats;
}
