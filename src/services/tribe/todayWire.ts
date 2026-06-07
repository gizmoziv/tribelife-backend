/**
 * todayWire — maps the internal TodayPayload (from todayService) to the
 * mobile wire contract (from tribelife-mobile/services/api.ts).
 *
 * Internal shape  →  Wire shape
 * ─────────────────────────────────────────────────────────────────────────
 * ShabbatInfo (internal):
 *   candleLighting  ISO|null  →  candleLightingTime  "h:mm A"
 *   havdalah        ISO|null  →  havdalahTime        "h:mm A"
 *   parsha          str|null  →  parshaName          "Parashat X"
 *   parshaHebrew    str|null  →  parshaHebrew        str
 *   locationLabel   str|null  →  locationLabel       str
 *   shabbatDate     YYYY-MM-DD|null → gregorianLabel "EEE, MMM D"
 *                                   + hebrewDate     Hebrew calendar string (from Hebcal converter)
 *   daysUntil       num|null  →  daysUntil           num
 *
 * DafYomi (internal):
 *   tractate / page / displayValue  →  tractate / page / englishName
 *
 * NEVER throws — any formatter / converter failure degrades to "" or 0.
 * hebrewDate uses the same daily in-memory cache as todayService.
 */

import type { TodayPayload as InternalTodayPayload } from './todayService';
import type { ShabbatInfo as InternalShabbatInfo } from './hebcal';
import type { DafYomi as InternalDafYomi } from './sefaria';

// ── Wire types (must match tribelife-mobile/services/api.ts exactly) ────────

export interface WireShabbatInfo {
  candleLightingTime: string;
  havdalahTime: string;
  locationLabel: string;
  daysUntil: number;
  parshaName: string;
  parshaHebrew: string;
  hebrewDate: string;
  gregorianLabel: string;
}

export interface WireDafYomi {
  tractate: string;
  page: string;
  englishName: string;
}

export interface WireTodayPayload {
  shabbat: WireShabbatInfo | null;
  daf: WireDafYomi | null;
  needsLocation: boolean;
}

// ── Time formatter ────────────────────────────────────────────────────────────

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * Parse the wall-clock time from an ISO 8601 string with offset, e.g.
 * "2026-06-19T20:12:00-04:00" → "8:12 PM".
 *
 * The ISO string produced by Hebcal already carries the location's UTC offset,
 * so the time portion (HH:MM) is already the *local* wall-clock time.
 * We just read it directly — no timezone conversion needed.
 *
 * If the ISO is null/empty, returns "".
 */
export function formatIsoToWallClock(iso: string | null): string {
  if (!iso) return '';
  // Match HH:MM from the time part (between T and any offset/Z)
  const m = iso.match(/T(\d{2}):(\d{2})(?::\d{2})?/);
  if (!m) return '';

  let hours = parseInt(m[1], 10);
  const minutes = parseInt(m[2], 10);
  const period = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  const mm = minutes.toString().padStart(2, '0');
  return `${hours}:${mm} ${period}`;
}

/**
 * Format a YYYY-MM-DD date string to "EEE, MMM D", e.g. "Sat, Jun 20".
 * Constructs the date as UTC midnight to avoid local-TZ day-boundary drift.
 * Returns "" on null/parse failure.
 */
export function formatGregorianLabel(dateStr: string | null): string {
  if (!dateStr) return '';
  // dateStr is "YYYY-MM-DD"
  const parts = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!parts) return '';
  const y = parseInt(parts[1], 10);
  const m = parseInt(parts[2], 10) - 1; // 0-indexed
  const d = parseInt(parts[3], 10);
  const date = new Date(Date.UTC(y, m, d));
  const dow = date.getUTCDay();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  return `${WEEKDAYS[dow]}, ${MONTHS[month]} ${day}`;
}

/**
 * Add the "Parashat " prefix to the internal parsha field if not already present.
 * Returns "" when parsha is null.
 */
export function formatParshaName(parsha: string | null): string {
  if (!parsha) return '';
  if (/^Parashat\s+/i.test(parsha) || /^Parshat\s+/i.test(parsha)) return parsha;
  return `Parashat ${parsha}`;
}

// ── Hebrew date converter (Hebcal converter API) ──────────────────────────────

interface HebcalConverterJson {
  hebrew?: string;
}

// Shared daily cache (reuse the module-scoped cache pattern from todayService).
// Key: "hdate:{YYYY-MM-DD}", value: Hebrew string or ""
const hdateCache = new Map<string, { value: string; expiresAt: number }>();

function nextUtcMidnight(now: Date): number {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

/**
 * Fetch the Hebrew calendar date for a given Gregorian date (YYYY-MM-DD).
 * Uses the Hebcal converter API: https://www.hebcal.com/converter
 * Degrades to "" on any failure. NEVER throws.
 * Caches per calendar day (same daily TTL boundary as todayService).
 */
export async function fetchHebrewDate(shabbatDate: string | null, now: Date): Promise<string> {
  if (!shabbatDate) return '';

  const cacheKey = `hdate:${shabbatDate}`;
  const existing = hdateCache.get(cacheKey);
  if (existing && existing.expiresAt > now.getTime()) {
    return existing.value;
  }

  const parts = shabbatDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!parts) return '';
  const [, y, m, d] = parts;

  try {
    const url =
      `https://www.hebcal.com/converter?cfg=json` +
      `&gy=${y}&gm=${parseInt(m, 10)}&gd=${parseInt(d, 10)}&g2h=1&strict=1`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`[hebcal/converter] HTTP ${res.status}`);
    }
    const json = (await res.json()) as HebcalConverterJson;
    const hebrewDate = json.hebrew ?? '';
    hdateCache.set(cacheKey, { value: hebrewDate, expiresAt: nextUtcMidnight(now) });
    return hebrewDate;
  } catch (err) {
    console.error('[todayWire] fetchHebrewDate failed for', shabbatDate, err);
    // Cache empty string so we don't hammer the API during an outage
    hdateCache.set(cacheKey, { value: '', expiresAt: nextUtcMidnight(now) });
    return '';
  }
}

// ── DafYomi mapper ────────────────────────────────────────────────────────────

function mapDaf(daf: InternalDafYomi | null): WireDafYomi | null {
  if (!daf) return null;
  return {
    tractate: daf.tractate,
    page: daf.page,
    englishName: daf.displayValue,
  };
}

// ── ShabbatInfo mapper ────────────────────────────────────────────────────────

function mapShabbat(internal: InternalShabbatInfo | null, hebrewDate: string): WireShabbatInfo | null {
  if (!internal) return null;
  // Emit shabbat: null only when BOTH parsha AND shabbatDate are null (total Hebcal failure)
  if (internal.parsha === null && internal.shabbatDate === null) return null;

  return {
    candleLightingTime: formatIsoToWallClock(internal.candleLighting),
    havdalahTime: formatIsoToWallClock(internal.havdalah),
    locationLabel: internal.locationLabel ?? '',
    daysUntil: internal.daysUntil ?? 0,
    parshaName: formatParshaName(internal.parsha),
    parshaHebrew: internal.parshaHebrew ?? '',
    hebrewDate,
    gregorianLabel: formatGregorianLabel(internal.shabbatDate),
  };
}

// ── Main mapper ───────────────────────────────────────────────────────────────

/**
 * Map internal TodayPayload → WireTodayPayload (mobile wire contract).
 * Accepts the hebrewDate string separately (async — fetched by toWireTodayPayload).
 */
export async function toWireTodayPayload(
  internal: InternalTodayPayload,
  now: Date,
): Promise<WireTodayPayload> {
  // Fetch Hebrew date (graceful degradation built in — never throws)
  const hebrewDate = await fetchHebrewDate(
    internal.shabbat?.shabbatDate ?? null,
    now,
  );

  return {
    shabbat: mapShabbat(internal.shabbat, hebrewDate),
    daf: mapDaf(internal.daf),
    needsLocation: internal.needsLocation,
  };
}
