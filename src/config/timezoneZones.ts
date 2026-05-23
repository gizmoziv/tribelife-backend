// ── Phase 15 (D-01): Canonical Timezone Zone Configuration ────────────────────
// Single source of truth for friendly-named timezone "zones" used as room keys.
// Replaces the per-IANA `timezone:<IANA>` room scheme with `timezone:<zone-slug>`
// so users in NY + Detroit + Toronto land in the same `timezone:eastern-time`
// room. `userProfiles.timezone` STAYS IANA for `Intl.DateTimeFormat` purposes;
// `getZoneForTimezone(iana)` translates IANA → zone slug at room-key time.
//
// Israel (Asia/Jerusalem) and India (Asia/Kolkata, UTC+5:30) are DISCRETE entries
// per user lock — they are NOT folded into the nearest hourly zone. Half-hour
// zones (Newfoundland, India) use fractional `utcOffsetHours`.
//
// MIRROR: `tribelife-mobile/utils/timezoneZones.ts` — keep in sync.

export interface TimezoneZone {
  slug: string;           // kebab-case, used as room key suffix
  displayName: string;    // user-facing label (matches Intl longGeneric where possible)
  utcOffsetHours: number; // representative offset (standard time); half-hour zones use fraction
  members: string[];      // IANA strings that map to this zone
}

export type ZoneSlug = string;

export const TIMEZONE_ZONES: TimezoneZone[] = [
  // ── North America ────────────────────────────────────────────────────────
  {
    slug: 'hawaii-time',
    displayName: 'Hawaii-Aleutian Time',
    utcOffsetHours: -10,
    members: ['Pacific/Honolulu', 'Pacific/Johnston', 'America/Adak'],
  },
  {
    slug: 'alaska-time',
    displayName: 'Alaska Time',
    utcOffsetHours: -9,
    members: ['America/Anchorage', 'America/Juneau', 'America/Nome', 'America/Sitka', 'America/Yakutat'],
  },
  {
    slug: 'pacific-time',
    displayName: 'Pacific Time',
    utcOffsetHours: -8,
    members: ['America/Los_Angeles', 'America/Vancouver', 'America/Tijuana'],
  },
  {
    slug: 'mountain-time',
    displayName: 'Mountain Time',
    utcOffsetHours: -7,
    members: ['America/Denver', 'America/Edmonton', 'America/Phoenix', 'America/Boise', 'America/Mazatlan'],
  },
  {
    slug: 'central-time',
    displayName: 'Central Time',
    utcOffsetHours: -6,
    members: ['America/Chicago', 'America/Winnipeg', 'America/Mexico_City', 'America/Regina', 'America/Indiana/Knox'],
  },
  {
    slug: 'eastern-time',
    displayName: 'Eastern Time',
    utcOffsetHours: -5,
    members: ['America/New_York', 'America/Detroit', 'America/Toronto', 'America/Indianapolis', 'America/Kentucky/Louisville'],
  },
  {
    slug: 'atlantic-time',
    displayName: 'Atlantic Time',
    utcOffsetHours: -4,
    members: ['America/Halifax', 'America/Bermuda', 'America/Barbados', 'America/Puerto_Rico'],
  },
  {
    slug: 'newfoundland-time',
    displayName: 'Newfoundland Time',
    utcOffsetHours: -3.5,
    members: ['America/St_Johns'],
  },
  // ── South America ────────────────────────────────────────────────────────
  {
    slug: 'brasilia-time',
    displayName: 'Brasilia Time',
    utcOffsetHours: -3,
    members: ['America/Sao_Paulo', 'America/Recife', 'America/Manaus', 'America/Fortaleza', 'America/Belem'],
  },
  {
    slug: 'argentina-time',
    displayName: 'Argentina Time',
    utcOffsetHours: -3,
    members: ['America/Argentina/Buenos_Aires', 'America/Argentina/Cordoba', 'America/Argentina/Mendoza'],
  },
  {
    slug: 'chile-time',
    displayName: 'Chile Time',
    utcOffsetHours: -4,
    members: ['America/Santiago', 'Pacific/Easter'],
  },
  {
    slug: 'colombia-peru-time',
    displayName: 'Colombia Time',
    utcOffsetHours: -5,
    members: ['America/Bogota', 'America/Lima', 'America/Guayaquil', 'America/Caracas'],
  },
  // ── Europe / Africa ──────────────────────────────────────────────────────
  {
    slug: 'greenwich-mean-time',
    displayName: 'Greenwich Mean Time',
    utcOffsetHours: 0,
    members: ['Europe/London', 'Europe/Dublin', 'Atlantic/Reykjavik', 'Africa/Casablanca', 'Africa/Abidjan'],
  },
  {
    slug: 'central-european-time',
    displayName: 'Central European Time',
    utcOffsetHours: 1,
    members: [
      'Europe/Paris',
      'Europe/Berlin',
      'Europe/Amsterdam',
      'Europe/Brussels',
      'Europe/Rome',
      'Europe/Madrid',
      'Europe/Zurich',
      'Europe/Vienna',
      'Europe/Stockholm',
      'Europe/Oslo',
      'Europe/Copenhagen',
      'Europe/Warsaw',
      'Europe/Prague',
      'Europe/Budapest',
    ],
  },
  {
    slug: 'eastern-european-time',
    displayName: 'Eastern European Time',
    utcOffsetHours: 2,
    members: ['Europe/Bucharest', 'Europe/Athens', 'Europe/Helsinki', 'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Harare'],
  },
  {
    slug: 'jerusalem-time',
    displayName: 'Israel Time',
    utcOffsetHours: 2,
    members: ['Asia/Jerusalem'],
  },
  {
    slug: 'moscow-time',
    displayName: 'Moscow Time',
    utcOffsetHours: 3,
    members: ['Europe/Moscow', 'Europe/Istanbul', 'Asia/Riyadh', 'Asia/Baghdad', 'Africa/Nairobi'],
  },
  // ── Asia / Pacific ───────────────────────────────────────────────────────
  {
    slug: 'india-standard-time',
    displayName: 'India Standard Time',
    utcOffsetHours: 5.5,
    members: ['Asia/Kolkata', 'Asia/Colombo'],
  },
  {
    slug: 'dubai-time',
    displayName: 'Gulf Standard Time',
    utcOffsetHours: 4,
    members: ['Asia/Dubai', 'Asia/Muscat'],
  },
  {
    slug: 'pakistan-time',
    displayName: 'Pakistan Time',
    utcOffsetHours: 5,
    members: ['Asia/Karachi'],
  },
  {
    slug: 'china-standard-time',
    displayName: 'China Standard Time',
    utcOffsetHours: 8,
    members: ['Asia/Shanghai', 'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Kuala_Lumpur'],
  },
  {
    slug: 'japan-standard-time',
    displayName: 'Japan Standard Time',
    utcOffsetHours: 9,
    members: ['Asia/Tokyo', 'Asia/Seoul'],
  },
  {
    slug: 'australia-eastern-time',
    displayName: 'Australian Eastern Time',
    utcOffsetHours: 10,
    members: ['Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Pacific/Port_Moresby'],
  },
  {
    slug: 'new-zealand-time',
    displayName: 'New Zealand Time',
    utcOffsetHours: 12,
    members: ['Pacific/Auckland', 'Pacific/Fiji'],
  },
  // ── UTC fallback ─────────────────────────────────────────────────────────
  {
    slug: 'utc',
    displayName: 'Coordinated Universal Time',
    utcOffsetHours: 0,
    members: ['UTC', 'Etc/UTC', 'Etc/GMT'],
  },
];

// Module-load-time reverse-lookup map (O(1) per call) built from TIMEZONE_ZONES.
const IANA_TO_SLUG = new Map<string, ZoneSlug>(
  TIMEZONE_ZONES.flatMap((z) => z.members.map((iana) => [iana, z.slug] as [string, ZoneSlug])),
);

/**
 * Translate an IANA timezone string to a canonical zone slug.
 * Falls back to 'utc' for any IANA not in the curated map (with console.warn).
 */
export function getZoneForTimezone(iana: string): ZoneSlug {
  const slug = IANA_TO_SLUG.get(iana);
  if (!slug) {
    console.warn(`[tzzone] unknown IANA "${iana}" — fallback to utc`);
    return 'utc';
  }
  return slug;
}

/** Check if a slug corresponds to a valid Timezone zone. */
export function isValidTimezoneRoom(slug: string): boolean {
  return TIMEZONE_ZONES.some((z) => z.slug === slug);
}

/** Find a Timezone zone by slug. */
export function getTimezoneZone(slug: ZoneSlug): TimezoneZone | undefined {
  return TIMEZONE_ZONES.find((z) => z.slug === slug);
}
