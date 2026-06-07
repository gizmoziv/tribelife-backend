/**
 * Region → GeoNames city ID mapping for Hebcal candle-lighting fallback.
 *
 * Used ONLY when the caller has no stored candle location — maps their
 * Globe region slug to a representative city so we can still return parsha
 * (Israel vs Diaspora) correctly. All IDs verified live (2026-06-07).
 *
 * When a user sets their own location via PUT /api/tribe/location, their
 * stored candle_geonameid or candle_lat/lon takes precedence over this map.
 */

// ── Region slug → GeoNames city ID ────────────────────────────────────────
export const REGION_TO_GEONAMEID: Record<string, number> = {
  'north-america': 5128581,   // New York City, USA
  'israel': 281184,           // Jerusalem, Israel
  'uk-ireland': 2643743,      // London, UK
  'europe': 2988507,          // Paris, France
  'latin-america': 3448439,   // São Paulo, Brazil
  'australia-nz': 2147714,    // Sydney, Australia
  'south-africa': 993800,     // Johannesburg, South Africa
};

/**
 * Fallback geonameid when no region is known (e.g., Town Square / unknown timezone).
 * Jerusalem — kept exported so callers that explicitly want the Israel city ID can
 * import it.  Do NOT use this as a timezone fallback: non-Israel users default to
 * NYC (Diaspora), not Jerusalem.
 */
export const DEFAULT_GEONAMEID = 281184; // Jerusalem

// ── Latin-America timezone membership set ─────────────────────────────────────
// Checked BEFORE the generic America/ prefix so they are not shadowed by
// the north-america catch-all.
const LATIN_AMERICA_ZONES = new Set([
  'America/Argentina/Buenos_Aires',
  'America/Argentina/Cordoba',
  'America/Argentina/Mendoza',
  'America/Argentina/Rosario',
  'America/Argentina/Salta',
  'America/Argentina/San_Juan',
  'America/Argentina/San_Luis',
  'America/Argentina/Tucuman',
  'America/Argentina/Ushuaia',
  'America/Argentina/Jujuy',
  'America/Argentina/La_Rioja',
  'America/Argentina/Catamarca',
  'America/Sao_Paulo',
  'America/Mexico_City',
  'America/Bogota',
  'America/Lima',
  'America/Santiago',
  'America/Montevideo',
  'America/Caracas',
  'America/Guatemala',
  'America/Costa_Rica',
  'America/Panama',
  'America/La_Paz',
  'America/Asuncion',
  'America/Manaus',
  'America/Recife',
  'America/Fortaleza',
  'America/Belem',
  'America/Cuiaba',
  'America/Porto_Velho',
  'America/Rio_Branco',
  'America/Bahia',
  'America/Guayaquil',
  'America/Paramaribo',
  'America/Cayenne',
  'America/Noronha',
]);

/**
 * Derive a representative geonameid from an IANA timezone string.
 *
 * Used only when the caller has no stored candle location — maps the timezone
 * to a representative city so Hebcal returns the correct parsha branch
 * (Israel vs Diaspora).
 *
 * Rules (evaluated in order):
 *   Israel family (Asia/Jerusalem etc.)     → Jerusalem  (Israel parsha)
 *   Latin-America set                       → São Paulo  (Diaspora)
 *   Any other America/* or Canada/*         → New York   (Diaspora)
 *   Europe/London, /Dublin, /Belfast, /Isle_of_Man → London (Diaspora)
 *   Any other Europe/*                      → Paris      (Diaspora)
 *   Australia/*, Pacific/Auckland, /Chatham → Sydney     (Diaspora)
 *   Africa/Johannesburg, /Maseru, /Mbabane  → Johannesburg (Diaspora)
 *   null / undefined / unknown              → New York   (Diaspora-safe default)
 */
export function geonameidFromTimezone(tzid: string | null | undefined): number {
  if (!tzid) {
    return REGION_TO_GEONAMEID['north-america']; // NYC — Diaspora default
  }

  // Israel
  if (
    tzid === 'Asia/Jerusalem' ||
    tzid === 'Asia/Tel_Aviv' ||
    tzid === 'Asia/Gaza' ||
    tzid === 'Asia/Hebron'
  ) {
    return REGION_TO_GEONAMEID['israel'];
  }

  // Latin America — must come before generic America/ check
  if (LATIN_AMERICA_ZONES.has(tzid)) {
    return REGION_TO_GEONAMEID['latin-america'];
  }

  // North America (remaining America/* and Canada/*)
  if (tzid.startsWith('America/') || tzid.startsWith('Canada/')) {
    return REGION_TO_GEONAMEID['north-america'];
  }

  // UK & Ireland
  if (
    tzid === 'Europe/London' ||
    tzid === 'Europe/Dublin' ||
    tzid === 'Europe/Belfast' ||
    tzid === 'Europe/Isle_of_Man'
  ) {
    return REGION_TO_GEONAMEID['uk-ireland'];
  }

  // Rest of Europe
  if (tzid.startsWith('Europe/')) {
    return REGION_TO_GEONAMEID['europe'];
  }

  // Australia / New Zealand
  if (
    tzid.startsWith('Australia/') ||
    tzid === 'Pacific/Auckland' ||
    tzid === 'Pacific/Chatham'
  ) {
    return REGION_TO_GEONAMEID['australia-nz'];
  }

  // South Africa
  if (
    tzid === 'Africa/Johannesburg' ||
    tzid === 'Africa/Maseru' ||
    tzid === 'Africa/Mbabane'
  ) {
    return REGION_TO_GEONAMEID['south-africa'];
  }

  // Unknown / unrecognised timezone → Diaspora-safe default (NYC, NOT Jerusalem)
  return REGION_TO_GEONAMEID['north-america'];
}
