/**
 * World News API (worldnewsapi.com) adapter for jpost, ynet, i24, haaretz outlets.
 *
 * Architecture (post 01-00 probe):
 *   ONE combined /search-news call per cron run fetches all 4 WNA outlets at once;
 *   response is cached at module scope for 2 minutes (longer than any cron run).
 *   The orchestrator in 01-05 calls fetch(outlet, log) per-outlet (interface unchanged);
 *   the first call in a run triggers the HTTP request and populates the cache,
 *   subsequent calls filter the cached result by outlet.feedUrl.
 *
 * Cost budget (empirically verified 01-00-WNA-PROBE.md):
 *   number=100 → max 2.0 pt/call (1 base + 100 × 0.01)
 *   24 runs/day × 2.0 pt = 48 pts/day max (fits 50-pt tier with 2 pt headroom)
 *   Typical (low-volume hour): 1.0-1.3 pt/call
 *
 * Encoding (INGEST-05): JSON responses are UTF-8 per RFC 8259. No decode work.
 *
 * Date parsing (Pitfall P-3):
 *   WNA returns publish_date in "YYYY-MM-DD HH:mm:ss" without timezone. Parse as
 *   new Date(publish_date.replace(' ', 'T') + 'Z') to explicitly mark UTC.
 *
 * Quota tracking (D-12): pointsUsed parsed from response header x-api-quota-request;
 *   logged on every run-initiating call.
 *
 * Parameter name + quota extraction empirically verified in 01-00-WNA-PROBE.md.
 */
import type { Logger } from 'pino';
import type { OutletRow, RawArticle } from './types';
import { getConfig } from './config';

const WNA_BASE_URL = 'https://api.worldnewsapi.com/search-news';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_NUMBER = 100;
const CACHE_TTL_MS = 120_000;  // 2 minutes — longer than any cron run, shorter than any cron interval

// Bare domains of all WNA outlets — filter matches article URL's host against these.
// Must match feed_url values in news_outlets seed (01-01) for WNA rows exactly.
const WNA_SOURCES = ['jpost.com', 'ynetnews.com', 'i24news.tv', 'haaretz.com'];

// Israel-focused topic filter — keeps WNA results on-topic if the source feed drifts.
const TOPIC_FILTER = 'jewish OR jews OR israel OR rabbi';

type WNAResponse = {
  news: Array<{
    title: string;
    url: string;
    image?: string | null;
    summary?: string | null;
    text?: string;
    author?: string | null;
    authors?: string[] | null;
    publish_date: string;
    language?: string;
    source_country?: string;
    sentiment?: number;
    category?: string;
  }>;
  available: number;
  offset: number;
  number: number;
};

type CachedRun = {
  fetchedAt: number;       // epoch ms
  raw: RawArticle[];       // all articles from combined call, not yet filtered by outlet
  pointsUsed: number;      // full cost of the combined call (parsed from header or estimated)
  pointsCharged: boolean;  // has pointsUsed been "paid" by the first fetch() caller in this run?
};

// Module-level cache — populated on first fetch() call in a run, reused for CACHE_TTL_MS.
let runCache: CachedRun | null = null;

/**
 * Fetches the combined WNA response if cache is empty or stale; returns the cache.
 * Centralizes env check, HTTP call, error handling, parsing, and pino log emission.
 */
async function ensureCache(log: Logger): Promise<CachedRun> {
  const now = Date.now();
  if (runCache && now - runCache.fetchedAt < CACHE_TTL_MS) {
    return runCache;
  }

  const apiKey = process.env.WORLD_NEWS_API_KEY;
  if (!apiKey) {
    throw new Error('WORLD_NEWS_API_KEY not set — cannot fetch from World News API');
  }

  // Look back cron_interval + 10% overlap to catch articles straddling run boundaries.
  const intervalMinutes = await getConfig<number>('cron_interval_minutes', 60);
  const lookbackMs = Math.ceil(intervalMinutes * 60_000 * 1.1);
  const earliestDate = new Date(now - lookbackMs)
    .toISOString()        // "2026-04-16T22:00:00.000Z"
    .slice(0, 19)         // "2026-04-16T22:00:00"
    .replace('T', ' ');   // "2026-04-16 22:00:00"   ← P-6 format (UTC)

  const url = new URL(WNA_BASE_URL);
  url.searchParams.set('news-sources', WNA_SOURCES.join(','));
  url.searchParams.set('source-country', 'il');
  url.searchParams.set('language', 'en');
  url.searchParams.set('number', String(DEFAULT_NUMBER));
  url.searchParams.set('earliest-publish-date', earliestDate);
  url.searchParams.set('sort', 'publish-time');
  url.searchParams.set('sort-direction', 'DESC');
  url.searchParams.set('text', TOPIC_FILTER);

  log.debug(
    { url: url.toString(), earliestDate, sources: WNA_SOURCES },
    'WNA combined request',
  );

  const res = await globalThis.fetch(url, {
    headers: { 'x-api-key': apiKey },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`WNA ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as WNAResponse;

  // Points accounting — 01-00 confirmed: header `x-api-quota-request` is a float per-call cost.
  // Fallback: estimate formula 1 + 0.01 × returned count.
  const headerPoints = parseFloat(res.headers.get('x-api-quota-request') ?? '');
  const pointsUsed = Number.isFinite(headerPoints)
    ? headerPoints
    : 1 + (data.news?.length ?? 0) * 0.01;

  const raw: RawArticle[] = (data.news ?? [])
    .map((a): RawArticle => ({
      title: (a.title ?? '').trim(),
      sourceUrl: a.url ?? '',
      // P-3: explicit UTC marker on space-separated date
      publishedAt: new Date(a.publish_date.replace(' ', 'T') + 'Z'),
      imageUrl: a.image ?? null,
      summary: a.summary ?? null,
      author: a.author ?? a.authors?.[0] ?? null,
      originalLanguage: a.language ?? null,
    }))
    .filter((a) => a.sourceUrl && a.title);

  log.info(
    {
      outletsFetched: WNA_SOURCES.length,
      articlesReturned: raw.length,
      availableReported: data.available,
      pointsUsed,
      pointsLeftToday: parseFloat(res.headers.get('x-api-quota-left') ?? '') || null,
      pointsUsedToday: parseFloat(res.headers.get('x-api-quota-used') ?? '') || null,
    },
    'WNA combined response',
  );

  runCache = {
    fetchedAt: now,
    raw,
    pointsUsed,
    pointsCharged: false,
  };
  return runCache;
}

/**
 * Match an article's URL host against a bare-domain outlet feedUrl.
 * Strips leading `www.` so `ynetnews.com` matches both `www.ynetnews.com` and `ynetnews.com`.
 */
function hostMatchesOutlet(articleUrl: string, outletFeedUrl: string): boolean {
  try {
    const host = new URL(articleUrl).hostname.toLowerCase().replace(/^www\./, '');
    const needle = outletFeedUrl.toLowerCase().replace(/^www\./, '');
    return host === needle || host.endsWith('.' + needle);
  } catch {
    return false;
  }
}

/**
 * Fetches articles for a single outlet.
 *
 * The first invocation in a run triggers the combined WNA HTTP call (see ensureCache)
 * and populates a module-level cache for 2 minutes. Subsequent calls in the same run
 * filter the cached result by `outlet.feedUrl` — no additional HTTP.
 *
 * `pointsUsed` is reported on the first caller only (the one who paid the API cost).
 * Subsequent callers in the same run get `pointsUsed: 0` so the orchestrator's
 * running total stays accurate across all outlets.
 *
 * Throws on missing API key, HTTP !ok, or JSON parse errors — orchestrator catches
 * per-outlet per D-10 (log + skip + continue).
 */
export async function fetch(
  outlet: OutletRow,
  log: Logger,
): Promise<{ raw: RawArticle[]; pointsUsed: number }> {
  const cache = await ensureCache(log);

  const filtered = cache.raw.filter((a) => hostMatchesOutlet(a.sourceUrl, outlet.feedUrl));

  // First caller in a run pays the combined-call cost; later callers pay 0.
  let pointsUsed = 0;
  if (!cache.pointsCharged) {
    pointsUsed = cache.pointsUsed;
    cache.pointsCharged = true;
  }

  return { raw: filtered, pointsUsed };
}

/**
 * Test/operational helper: forcibly clear the run cache.
 * Intentionally NOT called by 01-05 orchestrator — cache expires via CACHE_TTL_MS naturally.
 * Exported for unit tests and ad-hoc ops use.
 */
export function _resetCache(): void {
  runCache = null;
}
