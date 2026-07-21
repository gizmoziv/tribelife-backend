import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import logger from '../lib/logger';
import { fetchAllProducts } from '../services/esek/esekClient';
import { upsertProducts, reconcileDelisted } from '../services/esek/esekStore';

const log = logger.child({ module: 'esek-sync' });

/**
 * ⚠ runEsekSync + startEsekSyncCron WRITE to the LIVE PRODUCTION database (via
 * upsertProducts / reconcileDelisted). They must only run behind the gated cron
 * (ESEK_SYNC_ENABLED=true) or the guarded human one-shot (scripts/run-esek-sync-once.ts).
 * Never invoke from an agent or ad-hoc.
 */

/**
 * Orchestrate one full Esek marketplace sync:
 *   fetchAllProducts (esekClient) → upsertProducts (esekStore) → reconcileDelisted.
 * reconcileDelisted delists every currently-live row whose shopifyId did NOT appear
 * in this run's fetch (with the empty-set guard living in esekStore). Logs a
 * start/complete line with counts + duration_ms. The body is wrapped so any failure
 * logs and returns zeroed counts rather than throwing out of the cron.
 */
export async function runEsekSync(): Promise<{
  fetched: number;
  upserted: number;
  delisted: number;
}> {
  const runStart = Date.now();
  log.info('Esek sync starting');
  try {
    const rows = await fetchAllProducts();
    const { upserted } = await upsertProducts(rows);
    const { delisted } = await reconcileDelisted(rows.map((r) => r.shopifyId));
    log.info(
      {
        fetched: rows.length,
        upserted,
        delisted,
        duration_ms: Date.now() - runStart,
      },
      'Esek sync complete',
    );
    return { fetched: rows.length, upserted, delisted };
  } catch (err) {
    log.error({ err, duration_ms: Date.now() - runStart }, 'Esek sync failed');
    return { fetched: 0, upserted: 0, delisted: 0 };
  }
}

/**
 * Schedule the daily Esek marketplace catalog sync at 05:30 UTC.
 * Sits in the quiet gap between the ATS feed pull (05:00) and the beacon
 * matcher (06:00) — no collision.
 *
 * Gated by ESEK_SYNC_ENABLED — this gate is OPERATIONAL, not legal. Esek exposes
 * a public Shopify products.json feed, so there is no permission blocker; the flag
 * defaults off only so the source goes live deliberately (a human triggers the
 * first sync via scripts/run-esek-sync-once.ts after migration 0038 is applied).
 * When unset (or anything != 'true') this returns null and the cron never runs —
 * the feed stays empty until the first manual sync.
 */
export function startEsekSyncCron(): ScheduledTask | null {
  if (process.env.ESEK_SYNC_ENABLED !== 'true') {
    log.warn('Esek sync cron DISABLED (set ESEK_SYNC_ENABLED=true to enable)');
    return null;
  }

  const task = cron.schedule(
    '30 5 * * *',
    async () => {
      try {
        await runEsekSync();
      } catch (err) {
        log.error({ err }, 'Esek sync cron failed');
      }
    },
    { timezone: 'UTC' },
  );

  log.info('Cron scheduled: daily Esek marketplace sync at 05:30 UTC');
  return task;
}
