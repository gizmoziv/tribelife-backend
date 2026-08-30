// ── Quick task 260830-etv (D-02, D-03): Job Location Keyword Table ────────────
//
// Maps a timezone zone slug (from `timezoneZones.ts`) to an array of free-text
// location keywords used to filter `job_postings.location` via case-insensitive
// substring (ILIKE) matching in `routes/jobs.ts`'s `?myLocation=true` path.
//
// This file deliberately does NOT import from `timezoneZones.ts` (or anything
// else) — zone slugs are referenced as plain string literals so this stays a
// pure, DB-free data module (`timezoneZones.ts` imports `db`).
//
// Split-timezone US states (e.g. Kentucky, Indiana, Michigan, which straddle
// two IANA zones) resolve to their PRIMARY/most-common zone by design — this
// simplification is accepted and locked (D-03), not a bug.
//
// Every abbreviation keyword (state 2-letter codes, DC, country codes) is
// stored PRE-PREFIXED with ", " (comma-space) — the standard "City, ST"
// rendering used by these job feeds. A bare 2-letter substring match would
// hit interior letters of unrelated words (a bare Indiana code matches
// "Washington"; a bare Oregon code matches "New York"), so the comma-space
// prefix is what keeps the substring match precise. Full state/country names
// are stored unprefixed.
//
// Zones absent from this table (e.g. `moscow-time`, `dubai-time`,
// `argentina-time`) intentionally yield an empty keyword list — this is the
// normal case for most of the 24 zones, not an error, and callers must never
// throw on a miss.

export const JOB_LOCATION_ZONES: Record<string, string[]> = {
  // ── US zones (full state names + comma-prefixed abbreviations) ────────────
  'pacific-time': [
    'California',
    ', CA',
    'Nevada',
    ', NV',
    'Oregon',
    ', OR',
    'Washington',
    ', WA',
  ],
  'mountain-time': [
    'Arizona',
    ', AZ',
    'Colorado',
    ', CO',
    'Idaho',
    ', ID',
    'Montana',
    ', MT',
    'New Mexico',
    ', NM',
    'Utah',
    ', UT',
    'Wyoming',
    ', WY',
  ],
  'central-time': [
    'Alabama',
    ', AL',
    'Arkansas',
    ', AR',
    'Illinois',
    ', IL',
    'Iowa',
    ', IA',
    'Kansas',
    ', KS',
    'Louisiana',
    ', LA',
    'Minnesota',
    ', MN',
    'Mississippi',
    ', MS',
    'Missouri',
    ', MO',
    'Nebraska',
    ', NE',
    'North Dakota',
    ', ND',
    'Oklahoma',
    ', OK',
    'South Dakota',
    ', SD',
    'Tennessee',
    ', TN',
    'Texas',
    ', TX',
    'Wisconsin',
    ', WI',
  ],
  'eastern-time': [
    'Connecticut',
    ', CT',
    'Delaware',
    ', DE',
    'Florida',
    ', FL',
    'Georgia',
    ', GA',
    'Indiana',
    ', IN',
    'Kentucky',
    ', KY',
    'Maine',
    ', ME',
    'Maryland',
    ', MD',
    'Massachusetts',
    ', MA',
    'Michigan',
    ', MI',
    'New Hampshire',
    ', NH',
    'New Jersey',
    ', NJ',
    'New York',
    ', NY',
    'North Carolina',
    ', NC',
    'Ohio',
    ', OH',
    'Pennsylvania',
    ', PA',
    'Rhode Island',
    ', RI',
    'South Carolina',
    ', SC',
    'Vermont',
    ', VT',
    'Virginia',
    ', VA',
    'West Virginia',
    ', WV',
    'District of Columbia',
    ', DC',
  ],
  'alaska-time': ['Alaska', ', AK'],
  'hawaii-time': ['Hawaii', ', HI'],

  // ── Non-US ─────────────────────────────────────────────────────────────
  'jerusalem-time': ['Israel', 'Jerusalem', 'Tel Aviv'],
  'greenwich-mean-time': [
    'United Kingdom',
    'England',
    'Scotland',
    'London',
    'Ireland',
    'Dublin',
    'Portugal',
    ', UK',
  ],
  'central-european-time': [
    'France',
    'Germany',
    'Netherlands',
    'Belgium',
    'Italy',
    'Spain',
    'Switzerland',
    'Austria',
    'Sweden',
    'Norway',
    'Denmark',
    'Poland',
  ],
  'australia-eastern-time': ['Australia', 'Sydney', 'Melbourne', 'Brisbane'],
  'new-zealand-time': ['New Zealand', 'Auckland'],

  // ── Canadian provinces (unambiguous zone mapping) ──────────────────────
  // eastern-time already declared above — append Canadian entries there is
  // not possible with object literal syntax, so Ontario/Quebec ride on the
  // same eastern-time key via array concatenation below.
};

// Canadian provinces appended post-declaration so each zone's array stays a
// single readable block above, grouped by geography rather than interleaved.
JOB_LOCATION_ZONES['eastern-time'].push('Ontario', 'Toronto', 'Quebec', 'Montreal');
JOB_LOCATION_ZONES['central-time'].push('Manitoba', 'Winnipeg');
JOB_LOCATION_ZONES['mountain-time'].push('Alberta', 'Calgary');
JOB_LOCATION_ZONES['pacific-time'].push('British Columbia', 'Vancouver');

/**
 * Look up the location keyword array for a zone slug.
 * Returns an empty array for any slug with no entry (the normal case for
 * most of the 24 zones) — never throws.
 */
export function getLocationKeywordsForZone(zoneSlug: string): string[] {
  return JOB_LOCATION_ZONES[zoneSlug] ?? [];
}
