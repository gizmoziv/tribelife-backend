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
 * Fallback geonameid when no region is known (e.g., Town Square / unknown).
 * Jerusalem is the sensible default for a Jewish community app — also ensures
 * Israel parsha is used as the fallback rather than Diaspora.
 */
export const DEFAULT_GEONAMEID = 281184; // Jerusalem

/**
 * Derive a representative geonameid from an IANA timezone string.
 * Asia/Jerusalem family → Jerusalem (Israel parsha).
 * All other timezones → DEFAULT_GEONAMEID (Diaspora-safe).
 *
 * This is only used when the caller has no stored candle location, to select
 * parsha branch (Israel vs Diaspora) via a single Hebcal call.
 */
export function geonameidFromTimezone(tzid: string | null | undefined): number {
  if (tzid && (tzid === 'Asia/Jerusalem' || tzid === 'Asia/Tel_Aviv' || tzid === 'Asia/Gaza' || tzid === 'Asia/Hebron')) {
    return REGION_TO_GEONAMEID['israel'];
  }
  return DEFAULT_GEONAMEID;
}
