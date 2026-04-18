/**
 * News Push History Retention Cron — runs daily at 03:00 UTC (D-02)
 *
 * Each run:
 *   1. Reads retention window (days) from news_config.news_push_history_retention_days
 *      via getConfig (fallback: DEFAULT_NEWS_PUSH_HISTORY_RETENTION_DAYS = 30)
 *   2. Computes cutoff = now - retentionDays * 86_400_000 ms
 *   3. Issues a single DELETE of news_push_history rows where sent_at < cutoff
 *   4. Emits one structured pino completion log
 *
 * Design:
 *   - No batching / no ctid chunking (D-08). At current scale the daily backlog
 *     is small; revisit if durationMs outliers appear in DO log observation.
 *   - Retention cron schedule itself is NOT DB-configurable (D-02, scope boundary);
 *     only the retention WINDOW is. Ingest schedule configurability lives in
 *     newsIngester.ts (CONFIG-01, Phase 2 Plan 03).
 *   - getConfig's 60s TTL cache is always cold at daily cadence — no restart
 *     required for DB-driven window changes (RETAIN-02).
 *   - Timezone explicit UTC to avoid process TZ env drift (mirrors newsIngester.ts).
 *   - Error boundary: top-level try/catch inside the cron callback; an inner
 *     throw bubbles up to the outer catch, never crashes the Node process.
 */
import cron from 'node-cron';
import { lt } from 'drizzle-orm';
import logger from '../lib/logger';
import { db } from '../db';
import { newsPushHistory } from '../db/schema';
import {
  getConfig,
  DEFAULT_NEWS_PUSH_HISTORY_RETENTION_DAYS,
} from '../services/news/config';

const log = logger.child({ module: 'news-retention-cron' });

export async function runNewsPushRetention(): Promise<{ deleted: number }> {
  const startedAt = Date.now();

  const retentionDays = await getConfig<number>(
    'news_push_history_retention_days',
    DEFAULT_NEWS_PUSH_HISTORY_RETENTION_DAYS,
  );

  const cutoff = new Date(startedAt - retentionDays * 86_400_000);

  log.info(
    { event: 'news_push_retention_starting', retentionDays, cutoff },
    'Retention run starting',
  );

  const rows = await db
    .delete(newsPushHistory)
    .where(lt(newsPushHistory.sentAt, cutoff))
    .returning({ id: newsPushHistory.id });

  const deleted = rows.length;
  const durationMs = Date.now() - startedAt;

  log.info(
    { event: 'news_push_retention_complete', deleted, cutoff, retentionDays, durationMs },
    'Retention run complete',
  );

  return { deleted };
}

export function startNewsPushRetentionCron(): void {
  // Daily at 03:00 UTC — off-peak globally, no collision with the
  // hourly news-ingester tick at :00 or the beacon matcher at 06:00 UTC.
  cron.schedule(
    '0 3 * * *',
    async () => {
      try {
        await runNewsPushRetention();
      } catch (err) {
        log.error({ err }, 'Cron run failed at top level');
      }
    },
    { timezone: 'UTC' },
  );

  log.info(
    { event: 'news_push_retention_scheduled', schedule: '0 3 * * *' },
    'Cron scheduled',
  );
}
