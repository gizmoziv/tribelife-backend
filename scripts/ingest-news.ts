/**
 * One-shot news ingestion trigger for local dev + TestFlight data-prep.
 *
 * Usage:
 *   npm run news:ingest                 # default 1h window (matches hourly cron)
 *   npm run news:ingest -- --hours=6    # temporarily widen WNA lookback to 6 hours
 *   npm run news:ingest -- --hours=24   # 24h catchup
 *
 * What it does:
 *   1. If --hours > 1, UPDATE news_config.cron_interval_minutes = hours * 60
 *      (this is the WNA earliest-publish-date lookback — RSS feeds ignore this)
 *   2. Invoke runNewsIngestion() — full pipeline: fetch → dedup → enrich → push-dispatch
 *   3. Restore news_config.cron_interval_minutes to its prior value
 *
 * Idempotent: articles are deduped by sha256(normalized URL). Safe to re-run.
 *
 * Push dispatch: will run but find zero eligible users until someone flips
 * `news_push_enabled=true` (post-migration 0008 default is false).
 *
 * Requires in .env:
 *   - DATABASE_URL
 *   - OPENAI_API_KEY
 *   - WORLD_NEWS_API_KEY (else 4 of 6 outlets fail; RSS outlets still work)
 */

import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db';
import { newsConfig } from '../src/db/schema';
import { runNewsIngestion } from '../src/services/news/newsIngester';

function parseHoursArg(): number {
  const arg = process.argv.find((a) => a.startsWith('--hours='));
  if (!arg) return 1;
  const n = Number(arg.split('=')[1]);
  if (!Number.isFinite(n) || n <= 0 || n > 168) {
    throw new Error(`--hours must be 1..168, got: ${arg}`);
  }
  return n;
}

async function getConfigRaw(key: string): Promise<unknown> {
  const [row] = await db
    .select({ value: newsConfig.value })
    .from(newsConfig)
    .where(sql`${newsConfig.key} = ${key}`)
    .limit(1);
  return row?.value;
}

async function setConfigRaw(key: string, value: unknown): Promise<void> {
  await db.execute(sql`
    INSERT INTO news_config (key, value, updated_at)
    VALUES (${key}, ${JSON.stringify(value)}::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `);
}

async function main(): Promise<void> {
  const hours = parseHoursArg();
  const minutes = hours * 60;

  console.log(`[ingest-news] Starting one-shot ingestion. Window: ${hours}h (${minutes}m)`);

  let priorInterval: unknown = null;
  const needsOverride = minutes !== 60;

  if (needsOverride) {
    priorInterval = await getConfigRaw('cron_interval_minutes');
    console.log(`[ingest-news] Prior cron_interval_minutes: ${JSON.stringify(priorInterval)}`);
    await setConfigRaw('cron_interval_minutes', minutes);
    console.log(`[ingest-news] Set cron_interval_minutes = ${minutes} for this run`);
  }

  try {
    await runNewsIngestion();
    console.log('[ingest-news] Ingestion run complete.');
  } finally {
    if (needsOverride) {
      const restoreValue = priorInterval ?? 60;
      await setConfigRaw('cron_interval_minutes', restoreValue);
      console.log(`[ingest-news] Restored cron_interval_minutes = ${JSON.stringify(restoreValue)}`);
    }
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[ingest-news] FATAL:', err);
  process.exit(1);
});
