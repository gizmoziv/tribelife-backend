import { Router, Response } from 'express';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { newsArticles, newsOutlets, newsReactions } from '../db/schema';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { attachNewsReactions } from '../utils/attachNewsReactions';
import { getConfig } from '../services/news/config';
import logger from '../lib/logger';

const log = logger.child({ module: 'news-feed' });
const router = Router();
router.use(requireAuth);

const PAGE_SIZE = 20;

// ── Cursor helpers ─────────────────────────────────────────────────────────
// Cursor is opaque base64 of `${publishedAtISO}|${id}` (compound keyset per D-02
// tiebreaker and Pitfall 3: same-publishedAt stability).
function encodeCursor(publishedAt: Date, id: number): string {
  return Buffer.from(`${publishedAt.toISOString()}|${id}`, 'utf8').toString('base64');
}

function decodeCursor(raw: string): { publishedAt: Date; id: number } | null {
  try {
    const [iso, idStr] = Buffer.from(raw, 'base64').toString('utf8').split('|');
    const d = new Date(iso);
    const id = parseInt(idStr, 10);
    // NaN guard — invalid cursor treated as no cursor (first page), never reflected in error
    if (isNaN(d.getTime()) || isNaN(id)) return null;
    return { publishedAt: d, id };
  } catch {
    return null;
  }
}

// ── GET /feed ──────────────────────────────────────────────────────────────
// Returns paginated news articles newest-first, with aggregated reactions.
// Implements: FEED-02 (pagination), FEED-03 (headline/outlet/time), FEED-06 (hasMore),
//             FEED-07 (imageUrl), FEED-09 (translatedTitle), FEED-10 (48h filter).
router.get('/feed', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const cursor = req.query.before ? decodeCursor(String(req.query.before)) : null;

  // FEED-10: max_article_age_hours from news_config (60s cached), default 48h
  const maxAgeHours = await getConfig<number>('max_article_age_hours', 48);

  // WHERE clause components:
  // - 48h age filter (FEED-10)
  // - importance IN ('breaking', 'major') — routine articles are deleted at enrichment time (D-08),
  //   but this guard also catches any that slip through
  // - rephrasedTitle IS NOT NULL — hides rows with enrichment failures (ENRICH-04)
  const ageFilter = sql`${newsArticles.publishedAt} > NOW() - (${maxAgeHours} || ' hours')::INTERVAL`;
  const importanceFilter = inArray(newsArticles.importance, ['breaking', 'major']);
  const notNullTitle = sql`${newsArticles.rephrasedTitle} IS NOT NULL`;

  // Keyset cursor filter: rows strictly older than cursor publishedAt, OR
  // same publishedAt with smaller id (D-02 tiebreaker — stable under concurrent inserts).
  const cursorFilter = cursor
    ? or(
        lt(newsArticles.publishedAt, cursor.publishedAt),
        and(eq(newsArticles.publishedAt, cursor.publishedAt), lt(newsArticles.id, cursor.id)),
      )
    : undefined;

  try {
    const rows = await db
      .select({
        id: newsArticles.id,
        sourceUrl: newsArticles.sourceUrl,
        imageUrl: newsArticles.imageUrl,
        summary: newsArticles.summary,
        publishedAt: newsArticles.publishedAt,
        rephrasedTitle: newsArticles.rephrasedTitle,
        translatedTitle: newsArticles.translatedTitle,
        originalLanguage: newsArticles.originalLanguage,
        importance: newsArticles.importance,
        outletName: newsOutlets.name,
        outletSlug: newsOutlets.slug,
      })
      .from(newsArticles)
      .innerJoin(newsOutlets, eq(newsOutlets.id, newsArticles.outletId))
      .where(and(ageFilter, importanceFilter, notNullTitle, cursorFilter))
      .orderBy(desc(newsArticles.publishedAt), desc(newsArticles.id))
      .limit(PAGE_SIZE + 1); // fetch 1 extra to determine hasMore

    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

    // Batch-attach reactions in one query (REACT-03, no N+1)
    const withReactions = await attachNewsReactions(page, userId);

    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.publishedAt, last.id) : null;

    res.json({ articles: withReactions, hasMore, nextCursor });
  } catch (err) {
    log.error({ err, userId }, 'Failed to fetch news feed');
    res.status(500).json({ error: 'Failed to load feed' });
  }
});

// ── POST /reactions/toggle ─────────────────────────────────────────────────
// Toggle a single (user, article, emoji) reaction. Supports D-07 multi-reaction:
// a user may hold multiple emoji reactions on the same article simultaneously.
// Implements: REACT-01 (reaction write), REACT-02 (news_reactions table).
//
// IMPORTANT: REST-only — no socket broadcasts on news reactions (v1.3 decision, PATTERNS callout #4).
// userId is sourced from JWT (req.user!.id), never from the request body (T-03-01-10).
const toggleReactionSchema = z.object({
  articleId: z.number().int().positive(),
  emoji: z.string().min(1).max(20),
});

router.post('/reactions/toggle', async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = toggleReactionSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  const userId = req.user!.id;
  const { articleId, emoji } = parse.data;

  try {
    // Verify article exists (cheap guard — 404 before touching news_reactions)
    const [exists] = await db
      .select({ id: newsArticles.id })
      .from(newsArticles)
      .where(eq(newsArticles.id, articleId))
      .limit(1);

    if (!exists) {
      res.status(404).json({ error: 'Article not found' });
      return;
    }

    // Check if THIS specific (user, article, emoji) tuple already exists.
    // D-07: we only toggle the clicked emoji — we do NOT delete other emoji for the same user.
    // The unique constraint (article_id, user_id, emoji) makes multi-reaction safe natively.
    const [existing] = await db
      .select({ id: newsReactions.id })
      .from(newsReactions)
      .where(
        and(
          eq(newsReactions.articleId, articleId),
          eq(newsReactions.userId, userId),
          eq(newsReactions.emoji, emoji),
        ),
      )
      .limit(1);

    if (existing) {
      await db.delete(newsReactions).where(eq(newsReactions.id, existing.id));
      log.info({ userId, articleId, emoji }, 'Reaction removed');
      res.json({ action: 'removed' });
    } else {
      await db.insert(newsReactions).values({ articleId, userId, emoji });
      log.info({ userId, articleId, emoji }, 'Reaction added');
      res.status(201).json({ action: 'added' });
    }
  } catch (err) {
    log.error({ err, userId, articleId, emoji }, 'Failed to toggle reaction');
    res.status(500).json({ error: 'Failed to toggle reaction' });
  }
});

export default router;
