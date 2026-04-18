/**
 * Shared types for the news-ingestion subsystem.
 *
 * These contracts are consumed by:
 *   - rssAdapter.ts (returns RawArticle[])
 *   - worldNewsAdapter.ts (returns { raw: RawArticle[]; pointsUsed: number })
 *   - articleStore.ts (accepts RawArticle[], returns IngestResult)
 *   - newsIngester.ts (reads OutletRow[], dispatches by IngestMethod)
 */

export type IngestMethod = 'rss' | 'world_news_api';

export type OutletRow = {
  id: number;
  slug: string;
  name: string;
  feedUrl: string;
  breakingFeedUrl: string | null;
  politicalLean: string;
  ingestMethod: IngestMethod;
  enabled: boolean;
};

export type RawArticle = {
  title: string;
  sourceUrl: string;
  publishedAt: Date;
  imageUrl: string | null;
  summary: string | null;
  author: string | null;
  originalLanguage?: string | null;
};

export type IngestResult = {
  inserted: number;
  duplicates: number;
};
