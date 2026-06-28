import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import logger from '../lib/logger';
import { runAtsScrape } from '../services/jobs/atsAdapter';

const log = logger.child({ module: 'ats-feeds-cron' });

/**
 * Schedule the daily ATS job-feed pull at 05:00 UTC.
 * Sits in the quiet gap between the JewishJobs scraper (04:30) and the beacon
 * matcher (06:00). Hardcoded schedule (matches jobsScraper.ts rationale).
 *
 * Gated by ATS_FEEDS_ENABLED — but UNLIKE the JewishJobs scraper this gate is
 * operational, not legal: Greenhouse/Lever public board APIs are sanctioned for
 * syndication, so there is no permission blocker. The flag defaults off only so
 * the source goes live deliberately (verify the org list first). It is a SEPARATE
 * flag from JOBS_SCRAPER_ENABLED so ATS feeds can ship without touching the paused
 * JewishJobs scraper.
 */
export function startAtsFeedsCron(): ScheduledTask | null {
  if (process.env.ATS_FEEDS_ENABLED !== 'true') {
    log.warn('ATS feeds cron DISABLED (set ATS_FEEDS_ENABLED=true to enable)');
    return null;
  }

  const task = cron.schedule(
    '0 5 * * *',
    async () => {
      try {
        await runAtsScrape();
      } catch (err) {
        log.error({ err }, 'ATS feeds cron failed');
      }
    },
    { timezone: 'UTC' },
  );

  log.info('Cron scheduled: daily ATS feed pull at 05:00 UTC');
  return task;
}

// Re-export for manual trigger (e.g. admin endpoint / one-off backfill)
export { runAtsScrape };
