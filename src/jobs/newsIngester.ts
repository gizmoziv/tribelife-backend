/**
 * News Ingestion Cron — schedule loaded at server boot from news_config
 *
 * Each run:
 *   1. SELECTs enabled outlets from news_outlets
 *   2. For each outlet: dispatches to rss or world_news_api adapter
 *   3. Writes normalized articles via articleStore (ON CONFLICT DO NOTHING)
 *   4. Emits per-outlet + run-level pino health logs (INGEST-07)
 *
 * Phase 2 CONFIG-01: the cron schedule is read from
 *   news_config.news_ingest_cron_schedule
 * at server boot via getConfig (default: DEFAULT_NEWS_INGEST_CRON_SCHEDULE = '0 * * * *'
 * — preserves historical hourly-at-:00 behavior). Restart-to-reload is acceptable.
 *
 * Invalid schedule policy (D-11, mirrors Phase 1 D-05 ALLOWED_ORIGINS template):
 *   - NODE_ENV === 'production' AND invalid  -> fatal log + process.exit(1)
 *   - non-production               AND invalid  -> warn log + fall back to default
 *
 * Timezone: explicit UTC (P-7 mitigation — do not depend on process TZ env var).
 * Error boundary: top-level try/catch inside the cron callback. Per-outlet
 * errors are handled inside runNewsIngestion itself (D-10 ingest).
 */
import cron from 'node-cron';
import logger from '../lib/logger';
import { runNewsIngestion } from '../services/news/newsIngester';
import {
  getConfig,
  DEFAULT_NEWS_INGEST_CRON_SCHEDULE,
} from '../services/news/config';

const log = logger.child({ module: 'news-ingester-cron' });

export async function startNewsIngesterCron(): Promise<void> {
  const raw = await getConfig<string>(
    'news_ingest_cron_schedule',
    DEFAULT_NEWS_INGEST_CRON_SCHEDULE,
  );

  let schedule = raw;

  if (!cron.validate(raw)) {
    if (process.env.NODE_ENV === 'production') {
      log.fatal(
        { event: 'news_ingest_schedule_invalid', value: raw },
        'news_config.news_ingest_cron_schedule is invalid',
      );
      process.exit(1);
    }
    log.warn(
      {
        event: 'news_ingest_schedule_invalid_fallback',
        value: raw,
        fallback: DEFAULT_NEWS_INGEST_CRON_SCHEDULE,
      },
      'Falling back to default schedule',
    );
    schedule = DEFAULT_NEWS_INGEST_CRON_SCHEDULE;
  }

  cron.schedule(
    schedule,
    async () => {
      try {
        await runNewsIngestion();
      } catch (err) {
        log.error({ err }, 'Cron run failed at top level');
      }
    },
    { timezone: 'UTC' },
  );

  log.info(
    { event: 'news_ingest_schedule_loaded', schedule },
    'Cron scheduled',
  );
}

// Named export for manual trigger (e.g., admin endpoint or ad-hoc test script)
export { runNewsIngestion };
