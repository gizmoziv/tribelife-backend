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
 * No DB imports. Uses global fetch (Node ES2022).
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
  const lookupKey = rawParsha ? rawParsha.replace(/['ʼ׳]/g, "'") : null;
  const parshaHebrew = lookupKey ? (PARSHA_HEBREW[lookupKey] ?? null) : null;

  const locationLabel = json.location?.title ?? null;

  // shabbatDate = the date of the parashat item (the Shabbat day itself)
  const shabbatDate = parshatItem?.date ?? (candleItem ? candleItem.date.split('T')[0] : null);

  // daysUntil: calendar days from today to candle-lighting date
  let daysUntil: number | null = null;
  if (candleLighting) {
    const candleDay = new Date(candleLighting.split('T')[0] + 'T00:00:00Z');
    const todayUTC = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    daysUntil = Math.round((candleDay.getTime() - todayUTC.getTime()) / 86_400_000);
  }

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
