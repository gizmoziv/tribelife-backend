/**
 * News Ingestion Cron — runs hourly at :00 UTC
 *
 * Each run:
 *   1. SELECTs enabled outlets from news_outlets
 *   2. For each outlet: dispatches to rss or world_news_api adapter
 *   3. Writes normalized articles via articleStore (ON CONFLICT DO NOTHING)
 *   4. Emits per-outlet + run-level pino health logs (INGEST-07)
 *
 * Timezone: explicit UTC (P-7 mitigation — do not depend on process TZ env var).
 * Error boundary: top-level try/catch inside the cron callback. Per-outlet
 * errors are handled inside runNewsIngestion itself (D-10).
 */
import cron from 'node-cron';
import logger from '../lib/logger';
import { runNewsIngestion } from '../services/news/newsIngester';

const log = logger.child({ module: 'news-ingester-cron' });

export function startNewsIngesterCron(): void {
  // Top of every hour, UTC
  cron.schedule('0 * * * *', async () => {
    try {
      await runNewsIngestion();
    } catch (err) {
      log.error({ err }, 'Cron run failed at top level');
    }
  }, { timezone: 'UTC' });

  log.info('Cron scheduled: hourly at :00 UTC');
}

// Named export for manual trigger (e.g., admin endpoint or ad-hoc test script)
export { runNewsIngestion };
