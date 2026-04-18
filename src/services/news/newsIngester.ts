/**
 * News ingestion orchestrator — selects enabled outlets, dispatches to per-method
 * adapters, writes normalized articles, logs per-outlet + run-level pino health.
 *
 * Contract:
 *   runNewsIngestion(): Promise<void>
 *   - Runs once per cron tick (or on manual invocation)
 *   - Sequential per-outlet processing (D-10 log+skip+continue on failure)
 *   - Per-outlet try/catch isolates errors — no single outlet failure aborts the run
 *   - All health signals go through pino structured logs (INGEST-07 / D-11)
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import logger from '../../lib/logger';
import { db } from '../../db';
import { newsOutlets } from '../../db/schema';
import * as rssAdapter from './rssAdapter';
import * as worldNewsAdapter from './worldNewsAdapter';
import * as articleStore from './articleStore';
import { enrichUnenriched } from './enrichment';
import { dispatchBreakingPushes } from './pushDispatcher';
import type { OutletRow } from './types';

const log = logger.child({ module: 'news-ingester' });

export async function runNewsIngestion(): Promise<void> {
  const runId = randomUUID();
  const runStart = Date.now();
  const runLog = log.child({ run_id: runId });

  runLog.info('Starting run');

  const outletsRaw = await db
    .select()
    .from(newsOutlets)
    .where(eq(newsOutlets.enabled, true));

  // Cast DB rows to OutletRow (columns match 1:1 — null-safety fine since ingestMethod is typed via pgEnum)
  const outlets = outletsRaw as unknown as OutletRow[];

  let totalInserted = 0;
  let totalDuplicates = 0;
  let totalPoints = 0;
  const failedSlugs: string[] = [];
  let succeededCount = 0;

  for (const outlet of outlets) {
    const outletStart = Date.now();
    const outletLog = runLog.child({
      outlet_id: outlet.id,
      outlet_slug: outlet.slug,
      ingest_method: outlet.ingestMethod,
    });

    try {
      let raw;
      let pointsUsed = 0;
      if (outlet.ingestMethod === 'rss') {
        raw = await rssAdapter.fetch(outlet, outletLog);
      } else {
        const res = await worldNewsAdapter.fetch(outlet, outletLog);
        raw = res.raw;
        pointsUsed = res.pointsUsed;
      }

      const { inserted, duplicates } = await articleStore.upsertArticles(raw, outlet.id);

      totalInserted += inserted;
      totalDuplicates += duplicates;
      totalPoints += pointsUsed;
      succeededCount++;

      outletLog.info({
        duration_ms: Date.now() - outletStart,
        fetched_count: raw.length,
        inserted_count: inserted,
        duplicate_count: duplicates,
        points_used: pointsUsed,
      }, 'outlet ingested');
    } catch (err) {
      failedSlugs.push(outlet.slug);
      outletLog.error({
        err,
        duration_ms: Date.now() - outletStart,
      }, 'outlet ingestion failed');
      // Continue to next outlet — D-10
    }
  }

  // ── Phase 2: enrichment sweep (all outlets done, now enrich NULL rows) ──
  const enrichResult = await enrichUnenriched(runLog);

  // ── Phase 4: push dispatch sweep ──
  const pushResult = await dispatchBreakingPushes(runLog);

  runLog.info({
    total_outlets: outlets.length,
    successful_outlets: succeededCount,
    failed_outlets: failedSlugs,
    total_inserted: totalInserted,
    total_duplicates: totalDuplicates,
    total_points_used: totalPoints,
    // Phase 2 enrichment aggregates:
    enrichment_enriched: enrichResult.enriched,
    enrichment_failed: enrichResult.failed,
    enrichment_dropped_routine: enrichResult.droppedRoutine,
    enrichment_breaker_skipped: enrichResult.breakerSkipped,
    enrichment_cost_cents: enrichResult.costCents,
    // Phase 4 push dispatch aggregates:
    push_eligible: pushResult.eligible,
    push_sent: pushResult.sent,
    push_skipped_quiet: pushResult.skippedQuiet,
    push_skipped_cooldown: pushResult.skippedCooldown,
    push_skipped_quota: pushResult.skippedQuota,
    push_skipped_stale: pushResult.skippedStale,
    push_expo_errors: pushResult.expoErrors,
    run_duration_ms: Date.now() - runStart,
  }, 'Run complete');
}
