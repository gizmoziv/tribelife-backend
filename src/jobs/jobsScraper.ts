import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import logger from '../lib/logger';
import { runJobsScrape } from '../services/jobs/jobsScraper';

const log = logger.child({ module: 'jobs-scraper-cron' });

/**
 * Schedule the daily jobs scraper cron at 04:30 UTC.
 * Hardcoded (not DB-configurable) — per D-01, this is a once-a-day low-stakes
 * job; retuning via code change + deploy is acceptable.
 * Sits in the quiet gap between push-retention (03:00) and beacon matcher (06:00).
 */
export function startJobsScraperCron(): ScheduledTask {
  const task = cron.schedule(
    '30 4 * * *',
    async () => {
      try {
        await runJobsScrape();
      } catch (err) {
        log.error({ err }, 'Cron job failed');
      }
    },
    { timezone: 'UTC' },
  );

  log.info('Cron scheduled: daily at 04:30 UTC');
  return task;
}

// Re-export for manual trigger (e.g. admin endpoint)
export { runJobsScrape };
