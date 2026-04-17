/**
 * RSS adapter for Arutz Sheva (israelnationalnews.com) and C14 (www.c14.co.il).
 *
 * Encoding (INGEST-05):
 *   Both feeds serve UTF-8 natively. iconv-lite is NOT required for the 5
 *   launch outlets — rss-parser's xml2js backend respects the <?xml encoding?>
 *   prolog, and Node 22's fetch decodes UTF-8 natively. See RESEARCH.md
 *   § Hebrew Encoding Analysis.
 *
 * C14 Cloudflare (Pitfall P-1):
 *   www.c14.co.il returns HTTP 403 (cf-mitigated: challenge) to rss-parser's
 *   default "User-Agent: rss-parser/*.*.*" header and to curl/node-fetch
 *   default UAs. A Chrome-120 User-Agent bypasses the challenge. Verified
 *   empirically 2026-04-16.
 *
 * Arutz Sheva HTML entities (Pitfall P-2):
 *   Descriptions are double-HTML-encoded (&amp;lt; → &lt; → <). One pass of
 *   html-entities.decode() per title/summary normalizes to a single
 *   entity layer that renders cleanly as plain text.
 *
 * Date parsing (Pitfall P-3):
 *   Use item.isoDate (rss-parser auto-converts pubDate to UTC ISO 8601).
 *   Do NOT use item.pubDate — RFC 822 timezone variance (Arutz Sheva +0300,
 *   C14 +0000) would produce inconsistent publishedAt columns.
 */
import Parser from 'rss-parser';
import { decode } from 'html-entities';
import type { Logger } from 'pino';
import type { OutletRow, RawArticle } from './types';

type ParserItem = {
  title?: string;
  link?: string;
  guid?: string;
  isoDate?: string;
  content?: string;
  contentSnippet?: string;
  contentEncoded?: string;
  creator?: string;
  author?: string;
  enclosure?: { url?: string };
  mediaContent?: Array<{ $?: { url?: string } }>;
};

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ONE parser instance, reused across feeds and across cron runs (per RESEARCH.md).
const parser = new Parser<Record<string, unknown>, ParserItem>({
  timeout: 15_000,
  headers: {
    'User-Agent': BROWSER_UA,
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    'Accept-Language': 'en-US,en;q=0.9,he;q=0.8',
  },
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: true }],
      ['enclosure', 'enclosure'],
      ['dc:creator', 'creator'],
      ['content:encoded', 'contentEncoded'],
    ],
  },
});

/**
 * Fetch and parse the RSS feed for an outlet. Returns normalized RawArticle[].
 * Throws on HTTP errors, Cloudflare challenges, or XML parse failures — the
 * orchestrator (newsIngester.ts) catches these per-outlet and continues to
 * the next outlet (D-10).
 */
export async function fetch(
  outlet: OutletRow,
  log: Logger,
): Promise<RawArticle[]> {
  const url = outlet.breakingFeedUrl ?? outlet.feedUrl;  // INGEST-06: prefer breaking feed
  log.debug({ url }, 'fetching RSS');

  const feed = await parser.parseURL(url);

  const language = outlet.slug === 'c14' ? 'he' : 'en';

  return feed.items
    .map((item: ParserItem): RawArticle => ({
      title: decode((item.title ?? '').trim()),
      sourceUrl: item.link ?? item.guid ?? '',
      publishedAt: item.isoDate ? new Date(item.isoDate) : new Date(),
      imageUrl: extractImage(item),
      summary: decode((item.contentSnippet ?? item.content ?? '').slice(0, 500)),
      author: item.creator ?? item.author ?? null,
      originalLanguage: language,
    }))
    .filter((a) => a.sourceUrl && a.title);
}

/**
 * Extract the best-available image URL from an RSS item. Order:
 *   1. <enclosure url="..."> — Arutz Sheva
 *   2. <media:content url="..."> — WordPress / other CMSs
 *   3. First <img src="..."> inside content:encoded — fallback
 *
 * Returns null if no image present.
 */
function extractImage(item: ParserItem): string | null {
  if (item.enclosure?.url) return item.enclosure.url;
  if (Array.isArray(item.mediaContent) && item.mediaContent[0]?.$?.url) {
    return item.mediaContent[0].$.url;
  }
  const html = item.contentEncoded ?? item.content ?? '';
  const match = html.match(/<img[^>]+src=["']([^"']+)["']/);
  return match ? match[1] : null;
}
