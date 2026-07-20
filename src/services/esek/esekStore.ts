import { sql, and, eq, notInArray } from 'drizzle-orm';
import { db } from '../../db';
import { esekProducts } from '../../db/schema';
import logger from '../../lib/logger';
import type { EsekRow } from './esekClient';

const log = logger.child({ module: 'esek-sync' });

/**
 * Upsert a batch of mapped Esek product rows into esek_products.
 * On conflict (shopify_id): refresh the mutable set (D-04) and clear delisted —
 * a product reappearing in the feed flips delisted back to false (D-05).
 * Immutable fields (shopifyId, createdAt) are never overwritten, so the first-seen
 * createdAt is preserved.
 */
export async function upsertProducts(rows: EsekRow[]): Promise<{ upserted: number }> {
  if (rows.length === 0) return { upserted: 0 };

  const result = await db
    .insert(esekProducts)
    .values(rows.map((r) => ({ ...r, updatedAt: new Date() })))
    .onConflictDoUpdate({
      target: esekProducts.shopifyId,
      set: {
        title:          sql`EXCLUDED.title`,
        price:          sql`EXCLUDED.price`,
        compareAtPrice: sql`EXCLUDED.compare_at_price`,
        imageUrl:       sql`EXCLUDED.image_url`,
        available:      sql`EXCLUDED.available`,
        publishedAt:    sql`EXCLUDED.published_at`,
        vendor:         sql`EXCLUDED.vendor`,
        productType:    sql`EXCLUDED.product_type`,
        tags:           sql`EXCLUDED.tags`,
        updatedAt:      sql`NOW()`,
        delisted:       sql`false`, // reappeared in the feed → un-delist (D-05)
        // DO NOT include: shopifyId, createdAt (immutable — first-seen preserved)
      },
    })
    .returning({ id: esekProducts.id });

  log.info({ count: result.length }, 'upsertProducts complete');
  return { upserted: result.length };
}

/**
 * Full-catalog reconcile (D-05): mark delisted = true for every currently-live row
 * whose shopifyId did NOT appear in this run's fetched set.
 *
 * ⚠ Empty-set guard: an empty seenShopifyIds would delist the ENTIRE catalog, so we
 * treat an empty fetch as a failed run and do nothing. The out-of-stock half of D-05
 * (no available variant → available=false) is already handled by upsertProducts
 * refreshing `available` from EXCLUDED (mapProduct computed it), so no separate step
 * is needed here.
 */
export async function reconcileDelisted(
  seenShopifyIds: number[],
): Promise<{ delisted: number }> {
  if (seenShopifyIds.length === 0) {
    log.warn('reconcileDelisted skipped — empty fetch set (would delist entire catalog)');
    return { delisted: 0 };
  }

  const result = await db
    .update(esekProducts)
    .set({ delisted: true, updatedAt: new Date() })
    .where(
      and(
        eq(esekProducts.delisted, false),
        notInArray(esekProducts.shopifyId, seenShopifyIds),
      ),
    )
    .returning({ id: esekProducts.id });

  log.info({ count: result.length }, 'reconcileDelisted complete');
  return { delisted: result.length };
}
