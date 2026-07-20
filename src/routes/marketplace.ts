import { Router, Response } from 'express';
import { and, desc, eq, lt, or } from 'drizzle-orm';
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
// Opaque base64 cursor keyed on (createdAt, id) — stable compound keyset mirroring
// the news feed. Ties on created_at broken by id (serial PK, guaranteed unique).
function encodeCursor(createdAt: Date, id: number): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64');
}

function decodeCursor(raw: string): { createdAt: Date; id: number } | null {
  try {
    const [iso, idStr] = Buffer.from(raw, 'base64').toString('utf8').split('|');
    const d = new Date(iso);
    const id = parseInt(idStr, 10);
    // NaN guard — invalid cursor treated as no cursor (first page), never reflected in error
    if (isNaN(d.getTime()) || isNaN(id)) return null;
    return { createdAt: d, id };
  } catch {
    return null;
  }
}

// ── GET /esek/feed ───────────────────────────────────────────────────────────
// Keyset-paginated (created_at DESC, id DESC) in-stock, non-delisted Esek products
// newest-first, in the jobs-feed response shape { products, hasMore, nextCursor }.
// Served by esek_products_feed_idx (delisted, available, created_at DESC, id DESC).
const feedQuerySchema = z.object({ cursor: z.string().optional() });

router.get('/esek/feed', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;

  const parse = feedQuerySchema.safeParse(req.query);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  const cursor = parse.data.cursor ? decodeCursor(parse.data.cursor) : null;

  // Keyset cursor filter: rows strictly older than cursor createdAt, OR same
  // createdAt with smaller id (compound tiebreaker — stable under concurrent inserts).
  const cursorFilter = cursor
    ? or(
        lt(esekProducts.createdAt, cursor.createdAt),
        and(eq(esekProducts.createdAt, cursor.createdAt), lt(esekProducts.id, cursor.id)),
      )
    : undefined;

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
        createdAt: esekProducts.createdAt, // needed for the next cursor; not projected into the item
      })
      .from(esekProducts)
      .where(and(eq(esekProducts.available, true), eq(esekProducts.delisted, false), cursorFilter))
      .orderBy(desc(esekProducts.createdAt), desc(esekProducts.id))
      .limit(PAGE_SIZE + 1); // fetch 1 extra to determine hasMore

    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

    const products = page.map((row) => ({
      id: row.id,
      shopifyId: row.shopifyId,
      title: row.title,
      price: row.price,
      compareAtPrice: row.compareAtPrice,
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
