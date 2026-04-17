/**
 * URL normalization + SHA-256 hashing for article dedup (INGEST-04 / D-07).
 *
 * Normalization rules (all deliberate; see RESEARCH.md § URL Normalization):
 *   1. Force protocol to https (HTTP articles are functionally identical to HTTPS)
 *   2. Lowercase hostname
 *   3. Strip default ports (new URL() does this automatically)
 *   4. Strip query string entirely (utm_*, fbclid, gclid, ?ref=... are noise)
 *   5. Strip fragment
 *   6. Strip trailing slash from pathname (except bare root "/")
 *
 * Hashing: SHA-256 of the normalized URL bytes (UTF-8) → 64-char lowercase hex.
 * Matches the varchar(64) column width on news_articles.url_hash.
 */
import { createHash } from 'node:crypto';

export function normalizeUrl(rawUrl: string): string {
  const u = new URL(rawUrl);             // throws on invalid URL — let it propagate

  u.protocol = 'https:';
  u.hostname = u.hostname.toLowerCase();
  u.search = '';
  u.hash = '';

  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }

  return u.toString();
}

export function computeUrlHash(normalizedUrl: string): string {
  return createHash('sha256').update(normalizedUrl, 'utf8').digest('hex');
}
