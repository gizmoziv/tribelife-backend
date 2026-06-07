/**
 * GeoNames city-search proxy.
 *
 * Keeps the GEONAMES_USERNAME server-side; clients only receive
 * [{geonameid, label}] — no credentials ever reach the mobile app.
 *
 * In-memory TTL cache (~1 hour) keyed by lowercased query string,
 * mirrors the pattern in src/services/news/config.ts.
 *
 * If GEONAMES_USERNAME is not set, logs a warning and returns [].
 * If the upstream API fails, throws so the service layer can degrade.
 *
 * No DB imports. Uses global fetch (Node ES2022).
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface CityResult {
  geonameid: number;
  label: string;
}

// ── Cache ──────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

type CacheEntry = { value: CityResult[]; expiresAt: number };
const cache = new Map<string, CacheEntry>();

// ── GeoNames API ───────────────────────────────────────────────────────────

interface GeoNameItem {
  geonameId?: number;
  name?: string;
  adminName1?: string;
  countryName?: string;
}

interface GeoNamesJson {
  geonames?: GeoNameItem[];
}

/**
 * Search for cities matching the query string.
 * Results are cached per query for ~1 hour.
 * Returns [] when GEONAMES_USERNAME is not configured.
 */
export async function searchCities(q: string): Promise<CityResult[]> {
  const username = process.env.GEONAMES_USERNAME;
  if (!username) {
    console.warn('[geonames] GEONAMES_USERNAME not set — city search unavailable');
    return [];
  }

  const cacheKey = q.toLowerCase().trim();

  // Cache hit
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const encoded = encodeURIComponent(q.trim());
  const url = `http://api.geonames.org/searchJSON?q=${encoded}&maxRows=8&featureClass=P&username=${encodeURIComponent(username)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`[geonames] searchJSON → HTTP ${res.status}`);
  }

  const json = (await res.json()) as GeoNamesJson;
  const items = json.geonames ?? [];

  const results: CityResult[] = items
    .filter((g) => typeof g.geonameId === 'number')
    .map((g) => {
      const adminPart = g.adminName1 ? `${g.adminName1}, ` : '';
      const label = `${g.name ?? ''}, ${adminPart}${g.countryName ?? ''}`.replace(/^,\s*/, '');
      return { geonameid: g.geonameId as number, label };
    });

  cache.set(cacheKey, { value: results, expiresAt: now + CACHE_TTL_MS });
  return results;
}
