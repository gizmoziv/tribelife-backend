import { Router, Response } from 'express';
import { and, desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { esekProducts } from '../db/schema';
import { requireAuth, AuthRequest } from '../middleware/auth';
import logger from '../lib/logger';

const log = logger.child({ module: 'esek-feed' });
const router = Router();
router.use(requireAuth);

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

// ── GET /esek/feed ───────────────────────────────────────────────────────────
// Keyset-paginated (id DESC → newest-first, since id is monotonic with first-seen)
// in-stock, non-delisted Esek products, in the jobs-feed response shape
// { products, hasMore, nextCursor }. The esek_products_feed_idx
// (delisted, available, created_at DESC, id DESC) still serves the WHERE prefix.
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
      .where(and(eq(esekProducts.available, true), eq(esekProducts.delisted, false), cursorFilter))
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

export default router;
