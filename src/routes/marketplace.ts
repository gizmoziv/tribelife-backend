import { Router, Response } from 'express';
import { and, desc, eq, gt, lt, lte } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { esekProducts } from '../db/schema';
import { requireAuth, requireApprovedAccess, AuthRequest } from '../middleware/auth';
import { logUserEvent } from '../services/userEvents';
import logger from '../lib/logger';

const log = logger.child({ module: 'esek-feed' });
const router = Router();
router.use(requireAuth);
// Phase 34 (D-17): pending/rejected users are blocked server-side, independent of the mobile block screen.
router.use(requireApprovedAccess);

const PAGE_SIZE = 20;

// ── Cursor helpers ─────────────────────────────────────────────────────────
// Opaque base64 cursor keyed on the serial PK `id` alone. A (createdAt, id) keyset
// is unsafe here: a full sync writes every row in one INSERT, so all rows share an
// identical created_at (single-statement now()), AND node-pg truncates Postgres'
// microsecond timestamp to JS millisecond precision — so the cursor's created_at
// can't round-trip an exact match and paging stalls after page 1. `id` is unique,
// monotonic with first-seen (so id DESC == newest-first), and lossless as a number.
function encodeCursor(id: number): string {
  return Buffer.from(String(id), 'utf8').toString('base64');
}

function decodeCursor(raw: string): { id: number } | null {
  try {
    const id = parseInt(Buffer.from(raw, 'base64').toString('utf8'), 10);
    // NaN guard — invalid cursor treated as no cursor (first page), never reflected in error
    if (Number.isNaN(id)) return null;
    return { id };
  } catch {
    return null;
  }
}

// ── Max-price cap ────────────────────────────────────────────────────────────
// Optional operator cap (USD) read from ESEK_MAX_PRICE on every call — never at module
// scope — so a bad value can't break boot and a change needs only a restart.
// Returns null (= no price filtering) for unset, blank, non-numeric, non-finite, or <= 0.
function getEsekMaxPrice(): number | null {
  const raw = process.env.ESEK_MAX_PRICE;
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const cap = Number(trimmed);
  if (!Number.isFinite(cap)) return null;
  if (cap <= 0) return null;
  return cap;
}

// ── GET /esek/feed ───────────────────────────────────────────────────────────
// Keyset-paginated (id DESC → newest-first, since id is monotonic with first-seen)
// in-stock, non-delisted Esek products, in the jobs-feed response shape
// { products, hasMore, nextCursor }. The esek_products_feed_idx
// (delisted, available, created_at DESC, id DESC) still serves the WHERE prefix.
// Additionally narrowed by an optional ESEK_MAX_PRICE cap (see getEsekMaxPrice). The
// price column is variants[0].price only, so a multi-variant product is judged on its
// first variant's price rather than on its cheapest variant.
const feedQuerySchema = z.object({ cursor: z.string().optional() });

router.get('/esek/feed', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;

  const parse = feedQuerySchema.safeParse(req.query);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  const cursor = parse.data.cursor ? decodeCursor(parse.data.cursor) : null;

  // Keyset cursor filter: rows with a smaller id than the cursor (id DESC order).
  const cursorFilter = cursor ? lt(esekProducts.id, cursor.id) : undefined;

  // Optional price cap: both predicates are undefined when no cap is active, so the SQL is
  // unchanged. The zero floor rides along with the cap (excludes zero-priced products).
  // price is a numeric column (string-typed in JS), so bounds are passed as strings.
  const maxPrice = getEsekMaxPrice();
  const maxPriceFilter = maxPrice !== null ? lte(esekProducts.price, String(maxPrice)) : undefined;
  const minPriceFilter = maxPrice !== null ? gt(esekProducts.price, '0') : undefined;

  try {
    const rows = await db
      .select({
        id: esekProducts.id,
        shopifyId: esekProducts.shopifyId,
        title: esekProducts.title,
        price: esekProducts.price,
        compareAtPrice: esekProducts.compareAtPrice,
        imageUrl: esekProducts.imageUrl,
        handle: esekProducts.handle,
      })
      .from(esekProducts)
      .where(
        and(
          eq(esekProducts.available, true),
          eq(esekProducts.delisted, false),
          cursorFilter,
          maxPriceFilter,
          minPriceFilter,
        ),
      )
      .orderBy(desc(esekProducts.id))
      .limit(PAGE_SIZE + 1); // fetch 1 extra to determine hasMore

    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.id) : null;

    const products = page.map((row) => ({
      id: row.id,
      shopifyId: row.shopifyId,
      title: row.title,
      // Postgres numeric comes back from node-pg as a string — coerce to number so the
      // { price: number } contract holds and the client can format / compare it directly.
      price: Number(row.price),
      compareAtPrice: row.compareAtPrice == null ? null : Number(row.compareAtPrice),
      imageUrl: row.imageUrl,
      handle: row.handle,
      productUrl: `https://esek.biz/products/${row.handle}`,
    }));

    res.json({ products, hasMore, nextCursor });
  } catch (err) {
    log.error({ err, userId }, 'Failed to fetch esek feed');
    res.status(500).json({ error: 'Failed to load feed' });
  }
});

// ── POST /esek/click ──────────────────────────────────────────────────────────
// Attribution/analytics: record a marketplace_item_click into user_events when a
// user taps through to a product. metadata = { marketplace, item_id } where item_id
// is the Shopify product id. `marketplace` is server-set (not client-supplied) so
// it can't be spoofed; add sibling endpoints when more marketplaces are onboarded.
const clickBodySchema = z.object({ shopifyId: z.number().int().positive() });

router.post('/esek/click', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;

  const parse = clickBodySchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  // logUserEvent is best-effort (never throws) — safe to await without a guard.
  await logUserEvent(userId, 'marketplace_item_click', {
    marketplace: 'esek',
    item_id: parse.data.shopifyId,
  });

  res.json({ ok: true });
});

export default router;
