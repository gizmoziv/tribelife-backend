/**
 * Hebcal shabbat client — two location forms supported:
 *   - fetchShabbatByGeonameid(geonameid, date?) — manual city pick or region fallback
 *   - fetchShabbatByLatLon(lat, lon, tzid, date?) — GPS coordinates
 *
 * Both forms hit hebcal.com/shabbat with cfg=json&M=on&leyning=off and return
 * the same ShabbatInfo shape. Parsha Israel/Diaspora is resolved automatically
 * by Hebcal based on the location's country code (Jerusalem → Israel parsha).
 *
 * Pure parser parseHebcalShabbat(json, now) is exported for unit testing.
 * Week selection (which week to show on Saturday / after Havdalah) is also pure:
 * see resolveShabbatWeek. No DB imports. Uses global fetch (Node ES2022).
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface ShabbatInfo {
  /** ISO datetime string of candle lighting, e.g. "2026-06-19T20:12:00-04:00" */
  candleLighting: string | null;
  /** ISO datetime string of havdalah */
  havdalah: string | null;
  /** Parsha English name, e.g. "Korach" */
  parsha: string | null;
  /** Parsha Hebrew name from static lookup */
  parshaHebrew: string | null;
  /** Location display label from Hebcal response */
  locationLabel: string | null;
  /** Date of upcoming Shabbat, e.g. "2026-06-20" */
  shabbatDate: string | null;
  /** Days until next Shabbat candle lighting (0 = today/tonight) */
  daysUntil: number | null;
}

// ── Parsha Hebrew lookup (53 weekly portions) ──────────────────────────────
// Keyed by English title as returned in Hebcal "Parashat X" items.
const PARSHA_HEBREW: Record<string, string> = {
  'Bereshit': 'בְּרֵאשִׁית', 'Noach': 'נֹחַ', 'Lech-Lecha': 'לֶךְ-לְךָ',
  'Vayera': 'וַיֵּרָא', 'Chayei Sara': 'חַיֵּי שָׂרָה', 'Toldot': 'תּוֹלְדֹת',
  'Vayetzei': 'וַיֵּצֵא', 'Vayishlach': 'וַיִּשְׁלַח', 'Vayeshev': 'וַיֵּשֶׁב',
  'Miketz': 'מִקֵּץ', 'Vayigash': 'וַיִּגַּשׁ', 'Vayechi': 'וַיְחִי',
  'Shemot': 'שְׁמוֹת', 'Vaera': 'וָאֵרָא', 'Bo': 'בֹּא',
  'Beshalach': 'בְּשַׁלַּח', 'Yitro': 'יִתְרוֹ', 'Mishpatim': 'מִשְׁפָּטִים',
  'Terumah': 'תְּרוּמָה', 'Tetzaveh': 'תְּצַוֶּה', 'Ki Tisa': 'כִּי תִשָּׂא',
  'Vayakhel': 'וַיַּקְהֵל', 'Pekudei': 'פְקוּדֵי', 'Vayakhel-Pekudei': 'וַיַּקְהֵל-פְקוּדֵי',
  'Vayikra': 'וַיִּקְרָא', 'Tzav': 'צַו', 'Shmini': 'שְׁמִינִי',
  'Tazria': 'תַזְרִיעַ', 'Metzora': 'מְּצֹרָע', 'Tazria-Metzora': 'תַזְרִיעַ-מְּצֹרָע',
  'Achrei Mot': 'אַחֲרֵי מוֹת', 'Kedoshim': 'קְדֹשִׁים', 'Achrei Mot-Kedoshim': 'אַחֲרֵי מוֹת-קְדֹשִׁים',
  'Emor': 'אֱמֹר', 'Behar': 'בְּהַר', 'Bechukotai': 'בְּחֻקֹּתַי', 'Behar-Bechukotai': 'בְּהַר-בְּחֻקֹּתַי',
  'Bamidbar': 'בְּמִדְבַּר', 'Nasso': 'נָשֹׂא', "Beha'alotcha": 'בְּהַעֲלֹתְךָ',
  "Sh'lach": 'שְׁלַח', 'Korach': 'קֹרַח', 'Chukat': 'חֻקַּת', 'Balak': 'בָּלָק',
  'Chukat-Balak': 'חֻקַּת-בָּלָק', 'Pinchas': 'פִּינְחָס', 'Matot': 'מַטּוֹת',
  'Masei': 'מַסְעֵי', 'Matot-Masei': 'מַטּוֹת-מַסְעֵי',
  'Devarim': 'דְּבָרִים', 'Vaetchanan': 'וָאֶתְחַנַּן', 'Eikev': 'עֵקֶב',
  "Re'eh": 'רְאֵה', 'Shoftim': 'שׁוֹפְטִים', 'Ki Teitzei': 'כִּי-תֵצֵא',
  'Ki Tavo': 'כִּי-תָבֹא', 'Nitzavim': 'נִצָּבִים', 'Vayeilech': 'וַיֵּלֶךְ',
  'Nitzavim-Vayeilech': 'נִצָּבִים-וַיֵּלֶךְ', 'Haazinu': 'הַאֲזִינוּ',
  "Vezot Haberakhah": 'וְזֹאת הַבְּרָכָה',
};

// ── Pure parser ────────────────────────────────────────────────────────────

interface HebcalItem {
  category: string;
  title: string;
  date: string;
}

interface HebcalJson {
  location?: { title?: string };
  items?: HebcalItem[];
}

/** Parse the trailing UTC offset of an ISO-8601 timestamp into milliseconds. 'Z'/none → 0. */
function parseIsoOffsetMs(iso: string): number {
  const m = iso.match(/([+-])(\d{2}):?(\d{2})$/);
  if (!m) return 0; // ends with 'Z' or has no offset
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) * 60_000;
}

/**
 * Calendar days from `now` to the candle-lighting date, counted in the LOCATION's
 * local timezone (derived from the offset embedded in the candle-lighting timestamp,
 * e.g. "...T19:55:00-04:00"). Returns null when there is no candle-lighting time.
 *
 * Exported so the response layer can recompute it FRESH per request: the cached
 * ShabbatInfo is bucketed by UTC day, so a value baked in at parse time goes stale
 * across the caller's local midnight (and a UTC-floored "today" over-counts in the
 * evening for western zones — 20:40 EDT = 00:40 UTC the next day).
 */
export function computeDaysUntil(candleLighting: string | null, now: Date): number | null {
  if (!candleLighting) return null;
  const candleDay = new Date(candleLighting.split('T')[0] + 'T00:00:00Z');
  const nowLocal = new Date(now.getTime() + parseIsoOffsetMs(candleLighting));
  const todayLocal = new Date(
    Date.UTC(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth(), nowLocal.getUTCDate()),
  );
  return Math.round((candleDay.getTime() - todayLocal.getTime()) / 86_400_000);
}

// ── Week selection ─────────────────────────────────────────────────────────
//
// Hebcal's /shabbat week for a query date starts at that date, or at the
// PRECEDING Friday when the date is a Saturday (so on Saturday the candles item
// is yesterday's). The query date is a UTC calendar date, so querying `now`
// directly flips to next week at UTC midnight: that is BEFORE Havdalah west of
// UTC (Americas) and long AFTER it east of UTC (Israel, Europe, Australia).
//
// Instead, query (now - 24h): that date always lands on or before the location's
// own local date, so the current (or just-finished) week comes back. Then roll
// over exactly once, to (Havdalah's date + 1), when the Havdalah instant has
// passed. Havdalah is an ISO timestamp with an offset, i.e. an absolute instant,
// so "passed" is judged on the location's own clock in every timezone.

/** The date to query Hebcal with: 24 hours before `now`. */
export function shabbatQueryDate(now: Date): Date {
  return new Date(now.getTime() - 24 * 60 * 60 * 1000);
}

/** True once the Havdalah instant is at or before `now`. False when absent/unparseable. */
export function havdalahHasPassed(info: ShabbatInfo, now: Date): boolean {
  if (!info.havdalah) return false;
  const t = Date.parse(info.havdalah);
  if (!Number.isFinite(t)) return false;
  return t <= now.getTime();
}

/**
 * Query date for the week AFTER the one `info` describes: the day after the
 * location-local date of its Havdalah (noon UTC, so the UTC date is unambiguous).
 * Null when there is no usable Havdalah.
 */
export function nextWeekQueryDate(info: ShabbatInfo): Date | null {
  if (!info.havdalah) return null;
  const m = info.havdalah.match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1, 12));
}

/**
 * Pick the week to show: the current one until its Havdalah has passed, then
 * next week's. At most two fetches, no loop; a failed rollover fetch keeps the
 * current week so the payload is never emptied by an upstream blip.
 */
export async function resolveShabbatWeek(
  fetchWeek: (queryDate: Date) => Promise<ShabbatInfo | null>,
  now: Date,
): Promise<ShabbatInfo | null> {
  const current = await fetchWeek(shabbatQueryDate(now));
  if (current === null || !havdalahHasPassed(current, now)) return current;
  const nextQuery = nextWeekQueryDate(current);
  if (nextQuery === null) return current;
  const next = await fetchWeek(nextQuery);
  return next ?? current;
}

/**
 * Parse a raw Hebcal JSON response into ShabbatInfo.
 * Pure function — takes `now` as a parameter so it is unit-testable.
 */
export function parseHebcalShabbat(json: HebcalJson, now: Date): ShabbatInfo {
  const items: HebcalItem[] = json.items ?? [];

  const candleItem = items.find((i) => i.category === 'candles');
  const havdalahItem = items.find((i) => i.category === 'havdalah');
  const parshatItem = items.find((i) => i.category === 'parashat');

  const candleLighting = candleItem?.date ?? null;
  const havdalah = havdalahItem?.date ?? null;

  // "Parashat Korach" → "Korach"
  const rawParsha = parshatItem?.title?.replace(/^Parashat\s+/, '') ?? null;
  const parsha = rawParsha;
  // Hebcal may return curly/right-single-quote (U+2019, U+02BC, U+05F3) in parsha
  // names like "Sh’lach", "Re’eh", "Beha’alotcha". Normalize to a
  // straight ASCII apostrophe so the PARSHA_HEBREW lookup keys always match.
  const lookupKey = rawParsha ? rawParsha.replace(/[‘’ʼ׳]/g, "'") : null;
  const parshaHebrew = lookupKey ? (PARSHA_HEBREW[lookupKey] ?? null) : null;

  const locationLabel = json.location?.title ?? null;

  // shabbatDate = the date of the parashat item (the Shabbat day itself)
  const shabbatDate = parshatItem?.date ?? (candleItem ? candleItem.date.split('T')[0] : null);

  // daysUntil: location-local calendar days from today to candle-lighting (see
  // computeDaysUntil). Recomputed fresh per request downstream (todayService) so the
  // UTC-day-bucketed cache can't serve a stale value across the caller's local midnight.
  const daysUntil = computeDaysUntil(candleLighting, now);

  return { candleLighting, havdalah, parsha, parshaHebrew, locationLabel, shabbatDate, daysUntil };
}

// ── Fetchers ───────────────────────────────────────────────────────────────

const HEBCAL_BASE = 'https://www.hebcal.com/shabbat';
const COMMON_PARAMS = 'cfg=json&M=on&leyning=off';

/** Build date query params if a date is provided (pins the week for deterministic caching). */
function dateParams(date?: Date): string {
  if (!date) return '';
  return `&gy=${date.getUTCFullYear()}&gm=${date.getUTCMonth() + 1}&gd=${date.getUTCDate()}`;
}

/**
 * Fetch Shabbat times for a GeoNames city ID.
 * Throws on non-2xx so the service layer can degrade gracefully.
 */
export async function fetchShabbatByGeonameid(geonameid: number, date?: Date): Promise<ShabbatInfo> {
  const url = `${HEBCAL_BASE}?${COMMON_PARAMS}&geonameid=${geonameid}${dateParams(date)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`[hebcal] geonameid=${geonameid} → HTTP ${res.status}`);
  }
  const json = (await res.json()) as HebcalJson;
  return parseHebcalShabbat(json, date ?? new Date());
}

/**
 * Fetch Shabbat times by latitude/longitude + IANA tzid.
 * Throws on non-2xx so the service layer can degrade gracefully.
 */
export async function fetchShabbatByLatLon(
  lat: number,
  lon: number,
  tzid: string,
  date?: Date,
): Promise<ShabbatInfo> {
  const url =
    `${HEBCAL_BASE}?${COMMON_PARAMS}` +
    `&latitude=${lat}&longitude=${lon}&tzid=${encodeURIComponent(tzid)}` +
    dateParams(date);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`[hebcal] lat=${lat},lon=${lon} → HTTP ${res.status}`);
  }
  const json = (await res.json()) as HebcalJson;
  return parseHebcalShabbat(json, date ?? new Date());
}
