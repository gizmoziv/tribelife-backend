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
 *
 * PAUSED BY DEFAULT pending written permission/licensing from JewishJobs.com.
 * Their copyright terms (jewishjobs.com/page/copyright) explicitly prohibit
 * scraping without explicit consent, so the automated daily scrape stays OFF
 * unless JOBS_SCRAPER_ENABLED=true is set. Returns null when disabled.
 */
export function startJobsScraperCron(): ScheduledTask | null {
  if (process.env.JOBS_SCRAPER_ENABLED !== 'true') {
    log.warn(
      'Jobs scraper cron DISABLED (set JOBS_SCRAPER_ENABLED=true to enable) — paused pending JewishJobs.com permission',
    );
    return null;
  }

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
