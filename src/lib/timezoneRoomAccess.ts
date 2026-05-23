// ── Phase 15 (D-08, TZRM-01): Timezone-Room Access Predicates ────────────────
// Single source of truth for the non-native timezone-room capability check.
// D-08 is the SOFT-membership invariant: a row in `globe_room_memberships`
// is necessary but NOT sufficient for access to a non-native timezone room
// — every read path (GET /messages, GET /chats, socket auto-join, etc.)
// MUST also re-check the caller's current capability via these predicates.
//
// Changing the eligibility rule for non-native timezone-room access is a
// one-file edit here — keep these functions PURE (no DB calls, no Express
// types) so all read/write paths can import them safely.
//
// Companion module: `tribelife-backend/src/services/capabilityInvalidation.ts`
// (Plan 15-03 Task 4) uses `callerCanAccessNonNativeTimezone` to compute the
// downgrade-eviction diff — DB membership rows are NEVER deleted on
// downgrade (D-09); only per-socket feed subscriptions are dropped.
import type { Capabilities } from '../types/capabilities';
import { getZoneForTimezone } from '../config/timezoneZones';

/**
 * Predicate: does the caller's current capability snapshot allow access to
 * a NON-NATIVE timezone room? Premium (paid) and org_admin tiers qualify;
 * free users do not. D-01 + D-08.
 */
export function callerCanAccessNonNativeTimezone(caps: Capabilities): boolean {
  return caps.isPremium === true || caps.tier === 'org_admin';
}

/**
 * Predicate: is the given timezone-room slug the caller's CURRENT native
 * zone (derived from their `userProfiles.timezone` IANA string)?
 * Used to short-circuit the cap check — native zone access is implicit.
 */
export function isCallerNativeForSlug(callerIana: string, slug: string): boolean {
  return slug === getZoneForTimezone(callerIana);
}

/**
 * Build the canonical `timezone:<slug>` room id (matches `messages.room_id`
 * post-migration 0019 and the `socket.join(...)` form in roomHandler.ts
 * + the auto-join loop in socket/index.ts).
 */
export function timezoneRoomId(slug: string): string {
  return 'timezone:' + slug;
}
