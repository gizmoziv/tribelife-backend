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
//         Members arrays must be byte-identical between the two files.
//         Backend-only additions (offset algorithm, OFFSET_TO_SLUG, FALLBACK_SLUG_CACHE)
//         must NOT be mirrored — Hermes Intl is unreliable for offset computation.
//
// ── Phase 16-07: getZoneMemberIds DB helper ────────────────────────────────
// Imported here (not in the mirror mobile file) because the backend config file
// is the natural co-location point per the plan. No circular dependency: db and
// db/schema do not import from this file.
import { db } from '../db';
import { userProfiles } from '../db/schema';
import { inArray, ne, and, isNotNull } from 'drizzle-orm';
import logger from '../lib/logger';

const tzLog = logger.child({ module: 'tzzone' });

export interface TimezoneZone {
  slug: string; // kebab-case, used as room key suffix
  displayName: string; // user-facing label (matches Intl longGeneric where possible)
  utcOffsetHours: number; // representative offset (standard time); half-hour zones use fraction
  members: string[]; // IANA strings that map to this zone
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
    members: [
      'America/Anchorage',
      'America/Juneau',
      'America/Nome',
      'America/Sitka',
      'America/Yakutat',
      // US/Canada completeness 2026-06-06
      'America/Metlakatla',
    ],
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
    members: [
      'America/Denver',
      'America/Edmonton',
      'America/Phoenix',
      'America/Boise',
      'America/Mazatlan',
      // Phase 17: well-known missing sub-zones (standard UTC-7, no DST)
      'America/Whitehorse',
      'America/Dawson_Creek',
      'America/Fort_Nelson',
      'America/Hermosillo',
      'America/Cambridge_Bay',
      // Phase 17 (prod coverage 2026-06-06): offset_fallback promotion — `US/Mountain` is a legacy alias for America/Denver
      'US/Mountain',
      // US/Canada completeness 2026-06-06
      'America/Creston',
      'America/Dawson',
      'America/Inuvik',
    ],
  },
  {
    slug: 'central-time',
    displayName: 'Central Time',
    utcOffsetHours: -6,
    members: [
      'America/Chicago',
      'America/Winnipeg',
      'America/Mexico_City',
      'America/Regina',
      'America/Indiana/Knox',
      // Phase 17: well-known missing sub-zones (standard UTC-6)
      'America/Indiana/Tell_City',
      'America/North_Dakota/Center',
      'America/North_Dakota/New_Salem',
      'America/North_Dakota/Beulah',
      // US/Canada completeness 2026-06-06
      'America/Menominee',
      'America/Rankin_Inlet',
      'America/Resolute',
      'America/Swift_Current',
    ],
  },
  {
    slug: 'eastern-time',
    displayName: 'Eastern Time',
    utcOffsetHours: -5,
    members: [
      'America/New_York',
      'America/Detroit',
      'America/Toronto',
      'America/Indianapolis',
      'America/Kentucky/Louisville',
      // Phase 17: well-known missing sub-zones (standard UTC-5)
      'America/Indiana/Indianapolis',
      'America/Indiana/Marengo',
      'America/Indiana/Petersburg',
      'America/Indiana/Vevay',
      'America/Indiana/Vincennes',
      'America/Indiana/Winamac',
      'America/Kentucky/Monticello',
      'America/Louisville',
      'America/Cancun',
      'America/Jamaica',
      'America/Panama',
      'America/Grand_Turk',
      'America/Havana',
      'America/Nassau',
      'America/Port-au-Prince',
      // US/Canada completeness 2026-06-06
      'America/Iqaluit',
    ],
  },
  {
    slug: 'atlantic-time',
    displayName: 'Atlantic Time',
    utcOffsetHours: -4,
    members: [
      'America/Halifax',
      'America/Bermuda',
      'America/Barbados',
      'America/Puerto_Rico',
      // Phase 17: well-known missing sub-zones (standard UTC-4)
      'America/Glace_Bay',
      'America/Moncton',
      'America/Goose_Bay',
      // US/Canada completeness 2026-06-06
      'America/Blanc-Sablon',
      'America/St_Thomas',
    ],
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
    members: [
      'America/Sao_Paulo',
      'America/Recife',
      'America/Manaus',
      'America/Fortaleza',
      'America/Belem',
    ],
  },
  {
    slug: 'argentina-time',
    displayName: 'Argentina Time',
    utcOffsetHours: -3,
    members: [
      'America/Argentina/Buenos_Aires',
      'America/Argentina/Cordoba',
      'America/Argentina/Mendoza',
    ],
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
    members: [
      'America/Bogota',
      'America/Lima',
      'America/Guayaquil',
      'America/Caracas',
    ],
  },
  // ── Europe / Africa ──────────────────────────────────────────────────────
  {
    slug: 'greenwich-mean-time',
    displayName: 'Greenwich Mean Time',
    utcOffsetHours: 0,
    members: [
      'Europe/London',
      'Europe/Dublin',
      'Atlantic/Reykjavik',
      'Africa/Casablanca',
      'Africa/Abidjan',
      // Phase 17: well-known missing sub-zones (standard UTC+0)
      'Europe/Lisbon',
      'Atlantic/Canary',
      'Europe/Isle_of_Man',
      'Europe/Guernsey',
      'Europe/Jersey',
      // Phase 17 (prod coverage 2026-06-06): offset_fallback promotion — `Eire` is a legacy alias for Europe/Dublin
      'Eire',
    ],
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
      // Phase 17: well-known missing sub-zones (standard UTC+1)
      'Europe/Belgrade',
      'Europe/Ljubljana',
      'Europe/Bratislava',
      'Europe/Zagreb',
      'Europe/Sarajevo',
      'Europe/Tirane',
      // Phase 17 (prod coverage 2026-06-06): offset_fallback promotion — Africa/Lagos (WAT, UTC+1)
      'Africa/Lagos',
    ],
  },
  {
    slug: 'eastern-european-time',
    displayName: 'Eastern European Time',
    utcOffsetHours: 2,
    members: [
      'Europe/Bucharest',
      'Europe/Athens',
      'Europe/Helsinki',
      'Africa/Cairo',
      'Africa/Johannesburg',
      'Africa/Harare',
      // Phase 17: well-known missing sub-zones (standard UTC+2)
      // NOTE: jerusalem-time (Asia/Jerusalem) stays in its own explicit entry below —
      // these +2 IANAs are culturally EET, not Israel. Never add Jerusalem here.
      'Europe/Kyiv',
      'Europe/Kiev',
      'Europe/Chisinau',
      'Europe/Sofia',
      'Europe/Tallinn',
      'Europe/Riga',
      'Europe/Vilnius',
      'Asia/Nicosia',
      'Asia/Beirut',
    ],
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
    members: [
      'Europe/Moscow',
      'Europe/Istanbul',
      'Asia/Riyadh',
      'Asia/Baghdad',
      'Africa/Nairobi',
      // Phase 17: well-known missing sub-zones (standard UTC+3)
      'Asia/Amman',
      'Asia/Damascus',
      'Europe/Minsk',
    ],
  },
  // ── Asia / Pacific ───────────────────────────────────────────────────────
  {
    slug: 'india-standard-time',
    displayName: 'India Standard Time',
    utcOffsetHours: 5.5,
    members: [
      'Asia/Kolkata',
      'Asia/Colombo',
      // Phase 17: deprecated Kolkata alias — older Android devices emit this
      'Asia/Calcutta',
    ],
  },
  {
    slug: 'dubai-time',
    displayName: 'Gulf Standard Time',
    utcOffsetHours: 4,
    members: ['Asia/Dubai', 'Asia/Muscat'],
  },
  // {
  //   slug: 'pakistan-time',
  //   displayName: 'Pakistan Time',
  //   utcOffsetHours: 5,
  //   members: ['Asia/Karachi'],
  // },
  {
    slug: 'indochina-time',
    displayName: 'Southeast Asia Time',
    utcOffsetHours: 7,
    members: [
      'Asia/Bangkok',
      'Asia/Jakarta',
      'Asia/Ho_Chi_Minh',
      'Asia/Saigon',
      'Asia/Phnom_Penh',
      'Asia/Vientiane',
      'Asia/Pontianak',
    ],
  },
  {
    slug: 'china-standard-time',
    displayName: 'China Standard Time',
    utcOffsetHours: 8,
    members: [
      'Asia/Shanghai',
      'Asia/Singapore',
      'Asia/Hong_Kong',
      'Asia/Taipei',
      'Asia/Kuala_Lumpur',
      // Phase 17 (prod coverage 2026-06-06): offset_fallback promotion — Asia/Manila (PHT, UTC+8)
      'Asia/Manila',
    ],
  },
  {
    slug: 'japan-standard-time',
    displayName: 'Japan Standard Time',
    utcOffsetHours: 9,
    members: ['Asia/Tokyo', 'Asia/Seoul'],
  },
  {
    slug: 'australia-central-time',
    displayName: 'Australian Central Time',
    utcOffsetHours: 9.5,
    members: ['Australia/Adelaide', 'Australia/Darwin', 'Australia/Broken_Hill'],
  },
  {
    slug: 'australia-eastern-time',
    displayName: 'Australian Eastern Time',
    utcOffsetHours: 10,
    members: [
      'Australia/Sydney',
      'Australia/Melbourne',
      'Australia/Brisbane',
      'Pacific/Port_Moresby',
      // Phase 17: well-known missing sub-zone (standard UTC+10)
      'Australia/Hobart',
    ],
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
  TIMEZONE_ZONES.flatMap((z) =>
    z.members.map((iana) => [iana, z.slug] as [string, ZoneSlug]),
  ),
);

// ── Phase 17: Standard-offset algorithm (backend-only; NOT mirrored to mobile) ─
//
// Fixed DST-representative reference instants — Jan and Jul UTC noon, year 2025.
// These are module-level consts, NOT Date.now() — the algorithm is pure (same
// result every call, same process lifetime), which makes FALLBACK_SLUG_CACHE safe.
const JAN_REF = new Date('2025-01-15T12:00:00Z');
const JUL_REF = new Date('2025-07-15T12:00:00Z');

/**
 * Compute the wall-clock UTC offset (in hours) for an IANA timezone at a given instant.
 *
 * Uses Intl.DateTimeFormat formatToParts + Date.UTC reconstruction — NOT timeZoneName:'shortOffset'.
 * The Date.UTC reconstruction is required for correctness: naive hour arithmetic
 * fails for zones east of ~UTC+12 that cross midnight relative to UTC noon
 * (e.g. Auckland: UTC noon = 1am next calendar day → wall=1, utc=12, naive diff=-11 ≠ +13).
 *
 * Source: verified by live Node v24 execution; all 36 test cases pass (RESEARCH §1).
 */
function wallClockOffsetHours(tz: string, instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) =>
    parseInt(parts.find((p) => p.type === type)!.value);
  // Reconstruct the wall-clock instant as a UTC epoch value (handles day-boundary crossings),
  // then subtract the actual UTC epoch stripped of sub-minute precision.
  const wallMs = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
  );
  const utcMs =
    instant.getTime() -
    (instant.getUTCSeconds() * 1000 + instant.getUTCMilliseconds());
  return (wallMs - utcMs) / 3_600_000;
}

/**
 * Compute the standard-time UTC offset (hours) for an IANA timezone.
 *
 * Returns min(JanuaryOffset, JulyOffset):
 *   - Northern hemisphere: DST is in July → January = standard → min = January = standard
 *   - Southern hemisphere: DST is in January → July = standard → min = July = standard
 *   - No-DST zones: both equal → min = standard
 *
 * Throws if `tz` is not a valid IANA string (Intl will throw "Invalid time zone").
 */
export function computeStandardOffsetHours(tz: string): number {
  return Math.min(wallClockOffsetHours(tz, JAN_REF), wallClockOffsetHours(tz, JUL_REF));
}

/**
 * Offset → default zone slug tie-break table.
 *
 * ~24-entry hand-maintained map covering all distinct standard offsets present
 * in the missing-zone set (RESEARCH §3). Entries with offset collisions list
 * the preferred default (culturally-neutral majority zone); culturally-distinct
 * zones (jerusalem-time, india-standard-time) are NOT defaults — they are
 * reachable ONLY via the explicit IANA_TO_SLUG map, NEVER via this table.
 *
 * CRITICAL: offset +2 → 'eastern-european-time' (NEVER 'jerusalem-time').
 *           An unknown +2 IANA must never be routed into Israel's room.
 *
 * Rounding rule: before lookup, the caller rounds computeStandardOffsetHours()
 * to the nearest 0.5h. If the rounded value has no entry here, the caller falls
 * through to 'utc'. This handles any future exotic zones without crashing.
 */
const OFFSET_TO_SLUG = new Map<number, ZoneSlug>([
  [-10, 'hawaii-time'],
  [-9, 'alaska-time'],
  [-8, 'pacific-time'],
  [-7, 'mountain-time'],
  [-6, 'central-time'],
  [-5, 'eastern-time'], // collision: eastern wins over colombia-peru (North America majority)
  [-4, 'atlantic-time'], // collision: atlantic wins over chile (chile = DST offset of Santiago)
  [-3.5, 'newfoundland-time'],
  [-3, 'brasilia-time'], // collision: brasilia wins over argentina (argentina = explicit map)
  [0, 'greenwich-mean-time'], // collision: gmt wins over utc (utc = explicit map only)
  [1, 'central-european-time'],
  [2, 'eastern-european-time'], // collision: eet wins over jerusalem [CRITICAL — jerusalem = explicit only]
  [3, 'moscow-time'],
  [4, 'dubai-time'],
  [5.5, 'india-standard-time'], // only zone at +5.5; india-standard-time is also in explicit map
  [7, 'indochina-time'],
  [8, 'china-standard-time'],
  [9, 'japan-standard-time'],
  [9.5, 'australia-central-time'],
  [10, 'australia-eastern-time'],
  [12, 'new-zealand-time'],
  [12.75, 'new-zealand-time'], // Pacific/Chatham — NZ territory, nearest cultural fit (RESEARCH A1)
]);

/**
 * Memoization cache for the offset-fallback path only.
 *
 * The explicit IANA_TO_SLUG path (step 1) is already O(1) Map.get and is NOT
 * cached here — reading it again from this cache would be slower.
 *
 * Cache purity rationale: computeStandardOffsetHours is pure over fixed
 * JAN_REF/JUL_REF instants (not Date.now()), so a given IANA's resolved slug
 * never changes within a process. Bounded by the number of distinct fallback
 * IANAs that appear at runtime (≤ ~350 in Node v24 Intl).
 *
 * The hot path for this cache is socket/roomHandler.ts:65's .filter() over
 * room participants — after first sight of each IANA the cache collapses
 * subsequent calls to an O(1) Map.get.
 *
 * DISTINCT FROM SEEN_FALLBACK: FALLBACK_SLUG_CACHE governs one OFFSET COMPUTE
 * per distinct IANA (resolution memo). SEEN_FALLBACK governs one LOG LINE per
 * distinct IANA (observability dedup). They serve different purposes and must
 * not be merged — a cached resolution must still log on first sight, and the
 * log dedup must not bypass the resolution cache.
 */
const FALLBACK_SLUG_CACHE = new Map<string, ZoneSlug>();

/**
 * First-seen log-dedup set for the offset_fallback and utc_fallback paths.
 *
 * DISTINCT FROM FALLBACK_SLUG_CACHE: FALLBACK_SLUG_CACHE = one offset COMPUTE
 * per distinct IANA (resolution memo, from 17-01). SEEN_FALLBACK = one LOG LINE
 * per distinct IANA (observability dedup). They must not be merged.
 *
 * After the first time an IANA is logged, subsequent resolution calls (which hit
 * FALLBACK_SLUG_CACHE immediately) are silent — no repeated log spam.
 */
const SEEN_FALLBACK = new Set<string>();

/**
 * Translate an IANA timezone string to a canonical zone slug.
 *
 * Resolution order (locked per RESEARCH §Constraints):
 *   1. Explicit IANA_TO_SLUG map hit → return it immediately (O(1), uncached,
 *      byte-identical behavior for ~99% of users; covers all curated members).
 *   2. FALLBACK_SLUG_CACHE hit → return cached result (avoids recomputing offset
 *      for IANAs seen before on the fallback path).
 *      On miss: compute standard-time offset, round to nearest 0.5h, look up
 *      OFFSET_TO_SLUG. If found → log, cache, return the slug.
 *   3. Intl throws (invalid IANA) OR no OFFSET_TO_SLUG match → log warn, cache
 *      'utc' (so junk IANAs are computed at most once), return 'utc'.
 *
 * Rounding rule: Math.round(offset * 2) / 2 gives nearest 0.5h. If the rounded
 * value has no OFFSET_TO_SLUG entry, we give up and return 'utc' — no further
 * approximation (an unrecognized exotic zone must not bleed into an arbitrary room).
 */
export function getZoneForTimezone(iana: string): ZoneSlug {
  // Step 1: explicit map — O(1), uncached, covers ~99% of production IANAs.
  const explicit = IANA_TO_SLUG.get(iana);
  if (explicit !== undefined) return explicit;

  // Step 2: offset fallback with memoization.
  const cached = FALLBACK_SLUG_CACHE.get(iana);
  if (cached !== undefined) return cached;

  try {
    const offset = computeStandardOffsetHours(iana);
    // Round to nearest 0.5h to handle floating-point drift from the computation.
    const rounded = Math.round(offset * 2) / 2;
    const slug = OFFSET_TO_SLUG.get(rounded);
    if (slug !== undefined) {
      if (!SEEN_FALLBACK.has(iana)) {
        SEEN_FALLBACK.add(iana);
        tzLog.info(
          { event: 'tzzone_fallback', kind: 'offset_fallback', iana, slug },
          `resolved "${iana}" via standard offset ${offset}h (rounded ${rounded}h) → ${slug}`,
        );
      }
      FALLBACK_SLUG_CACHE.set(iana, slug);
      return slug;
    }
  } catch {
    // Intl threw — iana is not a valid IANA timezone string.
  }

  // Step 3: last resort — unresolvable IANA.
  if (!SEEN_FALLBACK.has(iana)) {
    SEEN_FALLBACK.add(iana);
    tzLog.warn(
      { event: 'tzzone_fallback', kind: 'utc_fallback', iana, slug: 'utc' },
      `unresolvable "${iana}" → utc`,
    );
  }
  FALLBACK_SLUG_CACHE.set(iana, 'utc');
  return 'utc';
}

/** Check if a slug corresponds to a valid Timezone zone. */
export function isValidTimezoneRoom(slug: string): boolean {
  return TIMEZONE_ZONES.some((z) => z.slug === slug);
}

/** Find a Timezone zone by slug. */
export function getTimezoneZone(slug: ZoneSlug): TimezoneZone | undefined {
  return TIMEZONE_ZONES.find((z) => z.slug === slug);
}

/**
 * Backward-compatibility shim for clients on or below v1.4.5 that still send
 * room IDs in the legacy `timezone:<IANA>` form (e.g. `timezone:America/New_York`).
 * Phase 15 migration 0019 consolidated all `messages.room_id`,
 * `notifications.data.roomId`, and related values to canonical zone slugs
 * (`timezone:<slug>`, e.g. `timezone:eastern-time`), which means old-client
 * lookups against the legacy IANA values now return zero rows.
 *
 * If the incoming room ID is `timezone:<IANA>` AND that IANA maps to one of
 * the curated `TIMEZONE_ZONES`, returns the canonical `timezone:<slug>` form
 * and sets `wasLegacy: true`. Otherwise returns the input untouched.
 *
 * Callers should log the wasLegacy=true case so the operator can monitor
 * residual 1.4.5-and-below traffic and decide when it is safe to delete the
 * shim. Delete plan: once `[shim:legacy-room-id]` logs trail off for a full
 * release cycle, remove the shim + this helper + the unit on
 * MIN_CLIENT_VERSION_* enforcement.
 *
 * L1 LANDMINE: This function MUST call IANA_TO_SLUG.get(value) directly and
 * MUST NOT use getZoneForTimezone(). An unknown legacy IANA must return zero
 * rows (input untouched), not silently route to a real zone (e.g. 'utc') and
 * expose orphaned messages to live users. The offset fallback would cause exactly
 * that undesired behavior for unknown legacy IANAs.
 */
export function translateLegacyTimezoneRoomId(roomId: string): {
  roomId: string;
  wasLegacy: boolean;
} {
  if (!roomId.startsWith('timezone:')) return { roomId, wasLegacy: false };
  const value = roomId.slice('timezone:'.length);
  // Already a known canonical slug → no translation needed.
  if (isValidTimezoneRoom(value)) return { roomId, wasLegacy: false };
  // Unknown payload that doesn't contain a `/` cannot be IANA → leave as-is.
  // IANA values are always `Continent/City` or `Continent/Region/City`.
  if (!value.includes('/')) return { roomId, wasLegacy: false };
  // IANA → slug ONLY when the IANA is in our curated map. Unknown / obsolete
  // IANA aliases (e.g. `US/Pacific`, legacy `America/Buenos_Aires`) are left
  // unchanged so the downstream query matches zero rows. The alternative —
  // `getZoneForTimezone`'s 'utc' fallback — would silently bucket the user
  // into the real `utc` zone and expose them to UTC users' messages /
  // mentions, which is a worse outcome than an empty result.
  const slug = IANA_TO_SLUG.get(value);
  if (!slug) return { roomId, wasLegacy: false };
  return { roomId: `timezone:${slug}`, wasLegacy: true };
}

// ── Phase 17-05: DB-free zone resolution classifier ───────────────────────
/**
 * Classify how an IANA timezone string is resolved to a zone slug.
 *
 * - 'explicit'       : IANA is a direct member of TIMEZONE_ZONES (O(1) map hit).
 * - 'offset_fallback': IANA is not in the explicit map but resolves via the
 *                      standard-offset algorithm to a named zone.
 * - 'utc_fallback'   : IANA is unresolvable (invalid string or no OFFSET_TO_SLUG
 *                      match) — routed to 'utc' as a last resort.
 *
 * Pure (no DB). Consistent with live routing by construction — reuses
 * getZoneForTimezone and the same IANA_TO_SLUG map. Do NOT duplicate offset logic.
 * Callers: GET /api/admin/timezone-coverage (operational visibility only).
 */
export function classifyZoneResolution(iana: string): {
  kind: 'explicit' | 'offset_fallback' | 'utc_fallback';
  slug: ZoneSlug;
} {
  if (IANA_TO_SLUG.has(iana)) {
    return { kind: 'explicit', slug: IANA_TO_SLUG.get(iana)! };
  }
  const slug = getZoneForTimezone(iana);
  if (slug === 'utc') {
    return { kind: 'utc_fallback', slug: 'utc' };
  }
  return { kind: 'offset_fallback', slug };
}

// ── Phase 16-07 (M2): Timezone room membership helper ─────────────────────
/**
 * Returns the userIds whose profile timezone maps to the given zoneSlug.
 * Optionally excludes `excludeUserId` (the message sender, per D-17).
 *
 * Timezone/Local Chat rooms have NO membership table — membership is IMPLICIT
 * in `userProfiles.timezone`. This helper narrows the SQL to only the IANA
 * strings that resolve to the requested slug (via `inArray`), which leverages
 * the `user_profiles_timezone_idx` index on the `timezone` column.
 *
 * Cost note: the candidate IANA list for a slug is small (typically 1-10
 * strings from TIMEZONE_ZONES.members), so the `inArray` predicate is cheap.
 * However the RESULT SET can be O(tens of thousands) for popular zones like
 * 'eastern-time'. Callers MUST batch notification inserts and push sends (M6)
 * rather than issuing N individual DB round-trips per recipient.
 */
export async function getZoneMemberIds(
  zoneSlug: string,
  excludeUserId?: number,
): Promise<number[]> {
  // Find all IANA strings that map to this slug (reverse-lookup from TIMEZONE_ZONES).
  const zone = TIMEZONE_ZONES.find((z) => z.slug === zoneSlug);
  if (!zone) return [];
  const ianaValues = zone.members;
  if (ianaValues.length === 0) return [];

  const conditions = [
    inArray(userProfiles.timezone, ianaValues),
    isNotNull(userProfiles.timezone),
  ];
  if (excludeUserId !== undefined) {
    conditions.push(ne(userProfiles.userId, excludeUserId));
  }

  const rows = await db
    .select({ userId: userProfiles.userId })
    .from(userProfiles)
    .where(and(...conditions));

  return rows.map((r) => r.userId);
}
