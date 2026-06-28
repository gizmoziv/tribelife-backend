/**
 * SPIKE (dry run): validate the legal ATS job-feed approach end-to-end.
 *
 * Run:  npx tsx scripts/spike-ats-jobs.ts
 *
 * Fetches every source in ATS_SOURCES (Greenhouse/Lever public board APIs),
 * maps each to a JobRow, and PRINTS the result. It does NOT connect to the
 * database and does NOT call upsertJobs — safe to run anytime, no prod-DB risk.
 *
 * Purpose: confirm Jewish-org ATS feeds return real, well-formed jobs before
 * wiring runAtsScrape() into the gated cron.
 */

import { ATS_SOURCES, fetchSource } from '../src/services/jobs/atsAdapter';

async function main() {
  let total = 0;
  for (const src of ATS_SOURCES) {
    process.stdout.write(`\n=== ${src.label} (${src.ats}/${src.token}) ===\n`);
    try {
      const rows = await fetchSource(src);
      total += rows.length;
      console.log(`  ${rows.length} jobs`);
      for (const j of rows.slice(0, 8)) {
        console.log(`  • ${j.title}`);
        console.log(`      ${j.location ?? 'Remote/Unspecified'}  |  posted ${j.postedDate ?? '—'}`);
        console.log(`      ${j.jobUrl}`);
        if (j.description) console.log(`      "${j.description.slice(0, 120)}…"`);
      }
      if (rows.length > 8) console.log(`  …and ${rows.length - 8} more`);
    } catch (err) {
      console.error(`  FAILED:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`\nTOTAL: ${total} jobs across ${ATS_SOURCES.length} source(s) — DRY RUN, nothing written.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
