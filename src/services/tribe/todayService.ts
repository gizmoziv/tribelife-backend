/**
 * todayService — assembles the "Today" payload for GET /api/tribe/today.
 *
 * Returns: { shabbat: ShabbatInfo | null, daf: DafYomi | null, needsLocation: boolean }
 *
 * - Daf Yomi: global, cache key "daf:global:{yyyy-mm-dd}"
 * - Shabbat + parsha: keyed by the caller's stored candle location (geonameid
 *   or lat/lon). When no location is stored, falls back to a timezone-derived
 *   geonameid so parsha (Israel vs Diaspora) is still correct, but
 *   shabbat.candleLighting is nulled out and needsLocation is set to true.
 * - Cache: daily TTL (expires at next UTC midnight). Promise.allSettled ensures
 *   an upstream failure in either Hebcal or Sefaria degrades to null, not a 500.
 * - NEVER throws to the caller.
 */

import { fetchShabbatByGeonameid, fetchShabbatByLatLon, type ShabbatInfo } from './hebcal';
import { fetchDafYomi, type DafYomi } from './sefaria';
import { geonameidFromTimezone } from '../../config/tribeRegions';

// ── Types ──────────────────────────────────────────────────────────────────

export interface TodayOptions {
  /** GeoNames city ID from the caller's stored manual pick */
  geonameid?: number;
  /** GPS latitude from the caller's stored location */
  lat?: number;
  /** GPS longitude from the caller's stored location */
  lon?: number;
  /** Caller's IANA timezone (always present from user_profiles.timezone) */
  tzid: string;
  /** Current time as ISO string (for daily cache key + pure-function boundary) */
  nowIso: string;
}

export interface TodayPayload {
  shabbat: ShabbatInfo | null;
  daf: DafYomi | null;
  /** true when no candle location is stored — app should show location prompt */
  needsLocation: boolean;
}

// ── Daily in-memory TTL cache ──────────────────────────────────────────────

type CacheEntry = { value: ShabbatInfo | DafYomi | null; expiresAt: number };
const cache = new Map<string, CacheEntry>();

/**
 * Returns the timestamp of the next UTC midnight (cache TTL boundary).
 * Cached values are valid for the current calendar day only.
 */
function nextUtcMidnight(now: Date): number {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

function cacheGet<T>(key: string, now: Date): T | undefined {
  const entry = cache.get(key);
  if (entry && entry.expiresAt > now.getTime()) {
    return entry.value as T;
  }
  return undefined;
}

function cacheSet(key: string, value: ShabbatInfo | DafYomi | null, now: Date): void {
  cache.set(key, { value, expiresAt: nextUtcMidnight(now) });
}

// ── Cache key helpers ──────────────────────────────────────────────────────

function dateKey(now: Date): string {
  return now.toISOString().slice(0, 10); // "yyyy-mm-dd"
}

function shabbatKeyGeonameid(geonameid: number, dateStr: string): string {
  return `shabbat:gid:${geonameid}:${dateStr}`;
}

function shabbatKeyLatLon(lat: number, lon: number, dateStr: string): string {
  return `shabbat:ll:${lat.toFixed(4)},${lon.toFixed(4)}:${dateStr}`;
}

function dafKey(dateStr: string): string {
  return `daf:global:${dateStr}`;
}

// ── Cached fetchers ────────────────────────────────────────────────────────

async function getShabbatByGeonameid(geonameid: number, now: Date): Promise<ShabbatInfo | null> {
  const key = shabbatKeyGeonameid(geonameid, dateKey(now));
  const cached = cacheGet<ShabbatInfo>(key, now);
  if (cached !== undefined) return cached;

  try {
    const result = await fetchShabbatByGeonameid(geonameid, now);
    cacheSet(key, result, now);
    return result;
  } catch (err) {
    console.error('[todayService] fetchShabbatByGeonameid failed', err);
    // Store null so we don't hammer the API on every request during an outage
    cacheSet(key, null, now);
    return null;
  }
}

async function getShabbatByLatLon(
  lat: number,
  lon: number,
  tzid: string,
  now: Date,
): Promise<ShabbatInfo | null> {
  const key = shabbatKeyLatLon(lat, lon, dateKey(now));
  const cached = cacheGet<ShabbatInfo>(key, now);
  if (cached !== undefined) return cached;

  try {
    const result = await fetchShabbatByLatLon(lat, lon, tzid, now);
    cacheSet(key, result, now);
    return result;
  } catch (err) {
    console.error('[todayService] fetchShabbatByLatLon failed', err);
    cacheSet(key, null, now);
    return null;
  }
}

async function getDafYomiCached(now: Date): Promise<DafYomi | null> {
  const key = dafKey(dateKey(now));
  const cached = cacheGet<DafYomi>(key, now);
  if (cached !== undefined) return cached;

  try {
    const result = await fetchDafYomi(now);
    cacheSet(key, result, now);
    return result;
  } catch (err) {
    console.error('[todayService] fetchDafYomi failed', err);
    cacheSet(key, null, now);
    return null;
  }
}

// ── Main service function ──────────────────────────────────────────────────

/**
 * Assemble today's parsha + daf + candle-lighting for a caller.
 *
 * Logic:
 *  1. Run Hebcal + Sefaria in parallel (Promise.allSettled — upstream failure → null).
 *  2. If the caller has a stored geonameid → fetch by geonameid (correct parsha + candle times).
 *  3. If the caller has stored lat/lon → fetch by lat/lon + tzid (correct parsha + candle times).
 *  4. If neither → derive a geonameid from timezone (Israel tz → Jerusalem, else NYC) for parsha
 *     ONLY; null out candleLighting+havdalah and set needsLocation=true.
 *
 * NEVER throws — all upstream errors degrade to null fields in the payload.
 */
export async function getToday(opts: TodayOptions): Promise<TodayPayload> {
  const now = new Date(opts.nowIso);

  const hasGeonameid = opts.geonameid !== undefined && opts.geonameid !== null;
  const hasLatLon =
    opts.lat !== undefined && opts.lat !== null &&
    opts.lon !== undefined && opts.lon !== null;

  try {
    let shabbatResult: ShabbatInfo | null = null;
    let needsLocation = false;

    // Run Hebcal + Sefaria in parallel
    const [shabbatSettled, dafSettled] = await Promise.allSettled([
      hasGeonameid
        ? getShabbatByGeonameid(opts.geonameid!, now)
        : hasLatLon
          ? getShabbatByLatLon(opts.lat!, opts.lon!, opts.tzid, now)
          : getShabbatByGeonameid(geonameidFromTimezone(opts.tzid), now),
      getDafYomiCached(now),
    ]);

    // Extract daf
    const daf: DafYomi | null =
      dafSettled.status === 'fulfilled' ? dafSettled.value : null;

    // Extract shabbat
    if (shabbatSettled.status === 'fulfilled') {
      shabbatResult = shabbatSettled.value;
    }

    // When no location stored: keep parsha from the timezone-derived call,
    // but null out the location-specific times and signal needsLocation.
    if (!hasGeonameid && !hasLatLon) {
      needsLocation = true;
      if (shabbatResult) {
        shabbatResult = {
          ...shabbatResult,
          candleLighting: null,
          havdalah: null,
        };
      }
    }

    return { shabbat: shabbatResult, daf, needsLocation };
  } catch (err) {
    // Outer catch: should never reach here due to allSettled, but belt-and-suspenders
    console.error('[todayService] unexpected error in getToday', err);
    return { shabbat: null, daf: null, needsLocation: !hasGeonameid && !hasLatLon };
  }
}
