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
 * - Cache: SHARED across instances via Redis (so horizontally-scaled pods return
 *   consistent results and don't each hammer upstream). Positive values expire at
 *   the next UTC midnight; negative (null) results use a short TTL so a transient
 *   upstream failure self-heals quickly instead of pinning an empty payload for
 *   the whole day. Promise.allSettled ensures an upstream failure in either Hebcal
 *   or Sefaria degrades to null, not a 500. If Redis is unavailable the cache is a
 *   no-op (recompute) — it never breaks the request.
 * - NEVER throws to the caller.
 */

import tzlookup from 'tz-lookup';
import { fetchShabbatByGeonameid, fetchShabbatByLatLon, computeDaysUntil, type ShabbatInfo } from './hebcal';
import { fetchDafYomi, type DafYomi } from './sefaria';
import { geonameidFromTimezone } from '../../config/tribeRegions';
import { redisGet, redisSet } from '../../lib/redisCache';

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
  /**
   * Human-readable location label stored on user_profiles (e.g. "Tel Aviv, Israel").
   * When present and non-empty, overrides Hebcal's raw location title (which can be
   * ugly raw coords like "37°19'N 122°1'W America/New_York" for lat/lon queries).
   */
  label?: string;
}

export interface TodayPayload {
  shabbat: ShabbatInfo | null;
  daf: DafYomi | null;
  /** true when no candle location is stored — app should show location prompt */
  needsLocation: boolean;
}

// ── Shared (cross-instance) TTL cache via Redis ─────────────────────────────

/** Namespaced + versioned key prefix (bump v1 to invalidate the whole cache). */
const CACHE_NS = 'tribe:today:v1:';
/** Short TTL for cached negative (null) results so a transient blip self-heals. */
const NEGATIVE_TTL_SECONDS = 300; // 5 minutes

/** Timestamp of the next UTC midnight — positive entries live until then. */
function nextUtcMidnight(now: Date): number {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

/** Seconds from `now` until the next UTC midnight (>= 1). */
function ttlToMidnightSeconds(now: Date): number {
  return Math.max(1, Math.floor((nextUtcMidnight(now) - now.getTime()) / 1000));
}

/**
 * Shared cache read. Returns:
 *  - undefined          → cache miss (caller should recompute)
 *  - { value: T | null }→ cache hit; `value` may be null (a cached negative result)
 *
 * The wrapper object lets us distinguish a genuine miss (key absent) from a
 * deliberately-cached null. Never throws (redisGet degrades to null on error).
 */
async function cacheGet<T>(key: string): Promise<{ value: T | null } | undefined> {
  const raw = await redisGet(CACHE_NS + key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as { value: T | null };
  } catch {
    return undefined; // corrupt entry → treat as miss
  }
}

/**
 * Shared cache write. Positive values expire at the next UTC midnight; null
 * (negative) results use a short TTL. Never throws (redisSet is a no-op on error).
 */
async function cacheSet(
  key: string,
  value: ShabbatInfo | DafYomi | null,
  now: Date,
): Promise<void> {
  const ttl = value === null ? NEGATIVE_TTL_SECONDS : ttlToMidnightSeconds(now);
  await redisSet(CACHE_NS + key, JSON.stringify({ value }), ttl);
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
  const cached = await cacheGet<ShabbatInfo>(key);
  if (cached !== undefined) return cached.value;

  try {
    const result = await fetchShabbatByGeonameid(geonameid, now);
    await cacheSet(key, result, now);
    return result;
  } catch (err) {
    console.error('[todayService] fetchShabbatByGeonameid failed', err);
    // Store null (short TTL) so we don't hammer the API on every request during a blip
    await cacheSet(key, null, now);
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
  const cached = await cacheGet<ShabbatInfo>(key);
  if (cached !== undefined) return cached.value;

  // Derive the timezone from GPS coordinates so Hebcal returns candle times
  // adjusted for the physical location — not the user's profile timezone.
  // Falls back to the profile tzid when coords are out of range.
  const resolvedTz = (() => {
    try {
      return tzlookup(lat, lon);
    } catch {
      return tzid;
    }
  })();

  try {
    const result = await fetchShabbatByLatLon(lat, lon, resolvedTz, now);
    await cacheSet(key, result, now);
    return result;
  } catch (err) {
    console.error('[todayService] fetchShabbatByLatLon failed', err);
    await cacheSet(key, null, now);
    return null;
  }
}

async function getDafYomiCached(now: Date): Promise<DafYomi | null> {
  const key = dafKey(dateKey(now));
  const cached = await cacheGet<DafYomi>(key);
  if (cached !== undefined) return cached.value;

  try {
    const result = await fetchDafYomi(now);
    await cacheSet(key, result, now);
    return result;
  } catch (err) {
    console.error('[todayService] fetchDafYomi failed', err);
    await cacheSet(key, null, now);
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

    // Override Hebcal's raw location title (which can be ugly lat/lon coords)
    // with the user's stored human-readable label (e.g. "Tel Aviv, Israel").
    // Only applies when a location is stored; the no-location fallback path
    // intentionally has no label to show.
    if (shabbatResult && opts.label && opts.label.trim().length > 0) {
      shabbatResult = { ...shabbatResult, locationLabel: opts.label };
    }

    // daysUntil is relative to "now" — recompute it fresh from the (absolute) candle
    // timestamp. The cached ShabbatInfo is bucketed by UTC day, so a baked daysUntil
    // would otherwise go stale across the caller's local midnight (off-by-one).
    if (shabbatResult) {
      shabbatResult = {
        ...shabbatResult,
        daysUntil: computeDaysUntil(shabbatResult.candleLighting, now),
      };
    }

    return { shabbat: shabbatResult, daf, needsLocation };
  } catch (err) {
    // Outer catch: should never reach here due to allSettled, but belt-and-suspenders
    console.error('[todayService] unexpected error in getToday', err);
    return { shabbat: null, daf: null, needsLocation: !hasGeonameid && !hasLatLon };
  }
}
