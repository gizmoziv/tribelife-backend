/**
 * linkPreview — Open Graph unfurl service.
 *
 * Given a URL, returns rich-preview metadata (title/description/image/siteName)
 * for rendering a link card. Fetches the page SSRF-safely (see ssrfGuard),
 * parses OG / Twitter / fallback tags with cheerio, and caches the result in
 * Redis (with an in-process fallback) so repeated unfurls of the same URL are
 * cheap.
 *
 * Contract: getLinkPreview NEVER throws. Any failure (SSRF block, fetch error,
 * timeout, non-HTML, no usable metadata) resolves to `null`, which the route
 * returns as `{ preview: null }` (a 200, not an error).
 */
import * as cheerio from 'cheerio';
import logger from '../lib/logger';
import { getJson, setJson } from '../lib/redisCache';
import { safeFetchHtml } from '../utils/ssrfGuard';

const log = logger.child({ module: 'link-preview' });

export interface Preview {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

const CACHE_PREFIX = 'linkpreview:v1:';
const POSITIVE_TTL_SECONDS = 24 * 60 * 60; // 24h
const NEGATIVE_TTL_SECONDS = 60 * 60; // 1h

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 300;

// Cache wrapper so we can distinguish a cached negative (preview === null) from
// a true cache miss (getJson returns null for both, so we wrap).
interface CacheEntry {
  preview: Preview | null;
}

/** Trim + collapse whitespace + cap length. Returns null for empty results. */
function clean(value: string | undefined | null, max: number): string | null {
  if (!value) return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Normalize a caller-supplied URL: add https:// when scheme-less. The route
 * passes full URLs, but this keeps the service usable directly/defensively.
 */
function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function firstMeta(
  $: cheerio.CheerioAPI,
  selectors: string[],
): string | undefined {
  for (const sel of selectors) {
    const content = $(sel).attr('content');
    if (content && content.trim()) return content;
  }
  return undefined;
}

/** Parse HTML into a Preview, resolving a relative image against finalUrl. */
function parsePreview(html: string, finalUrl: string): Preview | null {
  const $ = cheerio.load(html);

  const title =
    clean(
      firstMeta($, [
        'meta[property="og:title"]',
        'meta[name="og:title"]',
        'meta[name="twitter:title"]',
        'meta[property="twitter:title"]',
      ]),
      TITLE_MAX,
    ) ?? clean($('title').first().text(), TITLE_MAX);

  const description =
    clean(
      firstMeta($, [
        'meta[property="og:description"]',
        'meta[name="og:description"]',
        'meta[name="twitter:description"]',
        'meta[property="twitter:description"]',
      ]),
      DESCRIPTION_MAX,
    ) ?? clean($('meta[name="description"]').attr('content'), DESCRIPTION_MAX);

  const rawImage = firstMeta($, [
    'meta[property="og:image"]',
    'meta[name="og:image"]',
    'meta[name="og:image:secure_url"]',
    'meta[property="og:image:secure_url"]',
    'meta[name="twitter:image"]',
    'meta[property="twitter:image"]',
    'meta[name="twitter:image:src"]',
  ]);

  let image: string | null = null;
  if (rawImage && rawImage.trim()) {
    try {
      // Resolve relative image URLs against the final (post-redirect) page URL.
      image = new URL(rawImage.trim(), finalUrl).toString();
    } catch {
      image = null;
    }
  }

  let siteName = clean(
    firstMeta($, [
      'meta[property="og:site_name"]',
      'meta[name="og:site_name"]',
    ]),
    TITLE_MAX,
  );
  if (!siteName) {
    try {
      siteName = new URL(finalUrl).hostname || null;
    } catch {
      siteName = null;
    }
  }

  // "No usable metadata" → no title AND no image. Caller caches a negative.
  if (!title && !image) return null;

  return {
    url: finalUrl,
    title,
    description,
    image,
    siteName,
  };
}

/**
 * Resolve a rich link preview for `url`, or null. Checks the cache first
 * (including cached negatives), fetches SSRF-safely on a miss, parses, then
 * caches the result. Never throws.
 */
export async function getLinkPreview(url: string): Promise<Preview | null> {
  let normalized: string;
  try {
    normalized = normalizeUrl(url);
  } catch {
    return null;
  }

  const cacheKey = `${CACHE_PREFIX}${normalized}`;

  // Cache check (cached negatives are stored as { preview: null }).
  try {
    const cached = await getJson<CacheEntry>(cacheKey);
    if (cached) return cached.preview;
  } catch (err) {
    // getJson already swallows, but be defensive.
    log.error({ err, event: 'cache_read_failed' }, 'link preview cache read failed');
  }

  // Miss → fetch + parse.
  try {
    const fetched = await safeFetchHtml(normalized);
    if (!fetched) {
      await setJson(cacheKey, { preview: null }, NEGATIVE_TTL_SECONDS);
      return null;
    }

    const preview = parsePreview(fetched.html, fetched.finalUrl);
    if (!preview) {
      await setJson(cacheKey, { preview: null }, NEGATIVE_TTL_SECONDS);
      return null;
    }

    await setJson(cacheKey, { preview }, POSITIVE_TTL_SECONDS);
    return preview;
  } catch (err) {
    // SSRF block, transport error, timeout, etc. → negative, never throw.
    console.error('[link-preview]', err);
    await setJson(cacheKey, { preview: null }, NEGATIVE_TTL_SECONDS);
    return null;
  }
}
