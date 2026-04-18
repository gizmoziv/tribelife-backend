/**
 * Article store — single write path for news_articles.
 *
 * Dedup contract (INGEST-04 / D-07):
 *   Each article's source_url is normalized via ./urlNormalizer, hashed via
 *   SHA-256, and the hash is stored in news_articles.url_hash. The column has
 *   a UNIQUE constraint, and inserts use ON CONFLICT DO NOTHING, so duplicate
 *   source URLs are silently skipped at the DB layer.
 */
import { db } from '../../db';
import { newsArticles } from '../../db/schema';
import { normalizeUrl, computeUrlHash } from './urlNormalizer';
import type { RawArticle, IngestResult } from './types';

/**
 * Bulk-insert RawArticles for one outlet. Returns counts.
 * Articles missing sourceUrl or title are filtered out. URL normalization +
 * SHA-256 hashing happens here — adapters return raw URLs and this module
 * computes the dedup key.
 */
export async function upsertArticles(
  raw: RawArticle[],
  outletId: number,
): Promise<IngestResult> {
  if (raw.length === 0) return { inserted: 0, duplicates: 0 };

  const rows = raw
    .filter((r) => r.sourceUrl && r.title)                // skip malformed
    .map((r) => ({
      outletId,
      title: r.title,
      sourceUrl: r.sourceUrl,
      urlHash: computeUrlHash(normalizeUrl(r.sourceUrl)),
      publishedAt: r.publishedAt,
      imageUrl: r.imageUrl,
      summary: r.summary,
      author: r.author,
      originalLanguage: r.originalLanguage ?? null,
      // rephrasedTitle, importance, translatedTitle — Phase 2 populates
    }));

  if (rows.length === 0) return { inserted: 0, duplicates: 0 };

  const result = await db
    .insert(newsArticles)
    .values(rows)
    .onConflictDoNothing({ target: newsArticles.urlHash })
    .returning({ id: newsArticles.id });

  return {
    inserted: result.length,
    duplicates: rows.length - result.length,
  };
}
