/**
 * LOCAL-ONLY ATS backfill — for verifying the pipeline against a throwaway local
 * Postgres BEFORE going anywhere near production.
 *
 * ⚠ This project's .env DATABASE_URL points at LIVE PRODUCTION. This script is built
 *   so it CANNOT touch prod:
 *     1. It does NOT import 'dotenv/config', so the prod .env is never auto-loaded.
 *     2. It requires an explicit LOCAL_DATABASE_URL and HARD-REFUSES to run unless that
 *        URL points at localhost / 127.0.0.1.
 *     3. It sets process.env.DATABASE_URL from LOCAL_DATABASE_URL BEFORE importing the db
 *        pool. (dotenv.config() inside db/index.ts will not override an already-set var.)
 *
 * Run (after starting a local Postgres + creating the job_postings table — see the
 * runbook the assistant provided):
 *   LOCAL_DATABASE_URL=postgresql://postgres:postgres@localhost:5435/tribelife \
 *     npx tsx scripts/run-ats-feeds-local.ts
 */

async function main() {
  const local = process.env.LOCAL_DATABASE_URL;

  if (!local) {
    console.error(
      'Refusing to run: set LOCAL_DATABASE_URL to a localhost Postgres, e.g.\n' +
        '  LOCAL_DATABASE_URL=postgresql://postgres:postgres@localhost:5435/tribelife npx tsx scripts/run-ats-feeds-local.ts',
    );
    process.exit(1);
  }

  // Hard guard: only localhost / 127.0.0.1 hosts are permitted. Anything else (a
  // remote host, the prod string) aborts — this is the line that keeps prod safe.
  let host = '';
  try {
    host = new URL(local).hostname;
  } catch {
    console.error(`Refusing to run: LOCAL_DATABASE_URL is not a valid URL: ${local}`);
    process.exit(1);
  }
  if (host !== 'localhost' && host !== '127.0.0.1') {
    console.error(
      `Refusing to run: LOCAL_DATABASE_URL host is "${host}", not localhost/127.0.0.1. ` +
        'This script only ever writes to a local DB.',
    );
    process.exit(1);
  }

  // Set the connection string BEFORE importing anything that builds the pg pool.
  process.env.DATABASE_URL = local;

  // Dynamic import AFTER the override so db/index.ts reads the local URL.
  const { runAtsScrape } = await import('../src/services/jobs/atsAdapter');

  console.log(`Backfilling ATS feeds into LOCAL db @ ${host} ...`);
  const { fetched, inserted } = await runAtsScrape();
  console.log(`\nDone. Fetched ${fetched} jobs; upserted ${inserted} rows into local job_postings.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Local ATS backfill failed:', err);
  process.exit(1);
});
