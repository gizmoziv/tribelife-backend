/**
 * ⛔ HUMAN-RUN ONLY — this WRITES to the production database (via upsertProducts
 *    / reconcileDelisted). Do NOT run from an agent or automation. DATABASE_URL
 *    points at live prod.
 *
 * One-shot first-sync: pull the entire Esek (esek.biz) Shopify catalog and upsert
 * into esek_products immediately, instead of waiting for the 05:30 UTC cron. Use
 * this once after migration 0038 is applied so the Marketplace feed is populated
 * right away.
 *
 * Run:  npx tsx scripts/run-esek-sync-once.ts   (or: npm run esek:sync-once)
 *
 * Idempotent: re-running only refreshes mutable fields (onConflictDoUpdate on
 * shopify_id) and reconciles delisted; it never duplicates rows.
 */

import 'dotenv/config';
import { runEsekSync } from '../src/jobs/esekSync';

async function main() {
  const { fetched, upserted, delisted } = await runEsekSync();
  console.log(`\nDone. Fetched ${fetched} products; upserted ${upserted} rows; delisted ${delisted}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Esek sync failed:', err);
  process.exit(1);
});
