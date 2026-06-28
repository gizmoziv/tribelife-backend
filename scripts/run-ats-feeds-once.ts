/**
 * ⛔ HUMAN-RUN ONLY — this WRITES to the production database (via upsertJobs).
 *    Do NOT run from an agent or automation. DATABASE_URL points at live prod.
 *
 * One-shot backfill: pull every configured ATS source and upsert into job_postings
 * immediately, instead of waiting for the 05:00 UTC cron. Use this once after the
 * org list is finalized to populate the feed, and any time you add new ATS_SOURCES.
 *
 * Run:  npx tsx scripts/run-ats-feeds-once.ts
 *
 * Idempotent: re-running only refreshes mutable fields (onConflictDoUpdate on
 * source+external_ref); it never duplicates rows. For a no-DB preview of exactly
 * what would be written, use scripts/spike-ats-jobs.ts instead.
 */

import 'dotenv/config';
import { runAtsScrape } from '../src/services/jobs/atsAdapter';

async function main() {
  const { fetched, inserted } = await runAtsScrape();
  console.log(`\nDone. Fetched ${fetched} jobs; upserted ${inserted} rows into job_postings.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('ATS backfill failed:', err);
  process.exit(1);
});
