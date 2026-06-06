// ── Phase 17: Timezone Resolution Verification Script ────────────────────────
// Standalone tsx script — no test framework required.
// Run with: npx tsx tribelife-backend/src/scripts/verify-timezone-resolution.ts
//
// Asserts the minimum set from RESEARCH §L3 plus a parity regression guard
// that covers every IANA in every TIMEZONE_ZONES[].members entry.
//
// IMPORTANT: this script does NOT call getZoneMemberIds and does NOT open a
// DB connection. The `db` pool created at import time (via timezoneZones.ts →
// db/index.ts) is lazy — pg.Pool only connects on first query, never at
// module-load. (L4: live prod DB — no agent connections.)
//
// Exit codes: 0 = all assertions PASS, non-zero = one or more FAIL.

import { getZoneForTimezone, TIMEZONE_ZONES } from '../config/timezoneZones';

// ── Helpers ──────────────────────────────────────────────────────────────────

let failures = 0;

function assert(label: string, iana: string, expected: string): void {
  const actual = getZoneForTimezone(iana);
  const pass = actual === expected;
  if (!pass) failures++;
  const status = pass ? 'PASS' : 'FAIL';
  console.log(`${status}  ${label.padEnd(50)} expected=${expected} actual=${actual}`);
}

function assertNot(label: string, iana: string, forbidden: string): void {
  const actual = getZoneForTimezone(iana);
  const pass = actual !== forbidden;
  if (!pass) failures++;
  const status = pass ? 'PASS' : 'FAIL';
  console.log(`${status}  ${label.padEnd(50)} forbidden=${forbidden} actual=${actual}`);
}

// ── Minimum assertion set (RESEARCH §L3) ─────────────────────────────────────

console.log('\n── Minimum assertion set ────────────────────────────────────────────────');

assert('America/New_York → eastern-time',
  'America/New_York', 'eastern-time');

assert('America/Indiana/Indianapolis → eastern-time (bug anchor)',
  'America/Indiana/Indianapolis', 'eastern-time');

assert('Australia/Sydney → australia-eastern-time',
  'Australia/Sydney', 'australia-eastern-time');

assert('Asia/Jerusalem → jerusalem-time (explicit map, culturally distinct)',
  'Asia/Jerusalem', 'jerusalem-time');

assert('Asia/Kolkata → india-standard-time (explicit map)',
  'Asia/Kolkata', 'india-standard-time');

assert('Europe/Kyiv → eastern-european-time (NOT jerusalem-time)',
  'Europe/Kyiv', 'eastern-european-time');

assertNot('Europe/Kyiv must never resolve to jerusalem-time',
  'Europe/Kyiv', 'jerusalem-time');

assert('definitely/not-a-zone → utc (Intl throws → last resort)',
  'definitely/not-a-zone', 'utc');

// ── Additional spot-checks (Phase 17 critical entries) ────────────────────────

console.log('\n── Additional spot-checks ───────────────────────────────────────────────');

assert('Asia/Calcutta → india-standard-time (deprecated Kolkata alias)',
  'Asia/Calcutta', 'india-standard-time');

assert('Europe/Kiev → eastern-european-time (deprecated Kyiv alias)',
  'Europe/Kiev', 'eastern-european-time');

assert('America/Cancun → eastern-time (no-DST UTC-5)',
  'America/Cancun', 'eastern-time');

assert('America/Indiana/Tell_City → central-time',
  'America/Indiana/Tell_City', 'central-time');

assert('America/North_Dakota/Center → central-time',
  'America/North_Dakota/Center', 'central-time');

assert('America/Whitehorse → mountain-time',
  'America/Whitehorse', 'mountain-time');

assert('America/Glace_Bay → atlantic-time',
  'America/Glace_Bay', 'atlantic-time');

assert('Europe/Lisbon → greenwich-mean-time',
  'Europe/Lisbon', 'greenwich-mean-time');

assert('Atlantic/Canary → greenwich-mean-time',
  'Atlantic/Canary', 'greenwich-mean-time');

assert('Europe/Belgrade → central-european-time',
  'Europe/Belgrade', 'central-european-time');

assert('Asia/Amman → moscow-time',
  'Asia/Amman', 'moscow-time');

assert('Australia/Hobart → australia-eastern-time',
  'Australia/Hobart', 'australia-eastern-time');

assert('Asia/Bangkok → indochina-time',
  'Asia/Bangkok', 'indochina-time');

assert('Australia/Adelaide → australia-central-time',
  'Australia/Adelaide', 'australia-central-time');

assert('Australia/Darwin → australia-central-time',
  'Australia/Darwin', 'australia-central-time');

// ── Parity regression guard ───────────────────────────────────────────────────
// Every IANA in every TIMEZONE_ZONES[].members must resolve byte-identically
// to that zone's slug. This confirms the explicit map is internally consistent
// after the members expansion and that no member was accidentally assigned to
// the wrong zone.

console.log('\n── Parity regression guard (all TIMEZONE_ZONES members) ─────────────────');

let parityCount = 0;
for (const zone of TIMEZONE_ZONES) {
  for (const member of zone.members) {
    parityCount++;
    const actual = getZoneForTimezone(member);
    const pass = actual === zone.slug;
    if (!pass) {
      failures++;
      console.log(
        `FAIL  parity: ${member.padEnd(45)} expected=${zone.slug} actual=${actual}`,
      );
    }
  }
}
console.log(`PASS  parity guard: all ${parityCount} members resolved correctly (failures logged above if any)`);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n── Result ───────────────────────────────────────────────────────────────────`);
if (failures === 0) {
  console.log('ALL ASSERTIONS PASSED');
} else {
  console.log(`FAILED: ${failures} assertion(s) failed`);
}

process.exit(failures > 0 ? 1 : 0);
