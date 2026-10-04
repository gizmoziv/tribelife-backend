// verify-admin-handoff.mjs
//
// OFFLINE ONLY — never imported by app code. Exercises the pure group admin
// handoff rules in src/utils/adminHandoffRules.ts: who is promoted when the
// last admin of a user-created group leaves it or deletes their account, when
// the group is archived instead, and where conversations.created_by_id moves.
// No network, no database: the module has zero imports.
//
// Rules proven here (quick 261003-vpp, operator-locked):
//   - "Next oldest" = earliest joined_at among ACTIVE members (left_at null,
//     role not 'kicked', not already admin, not banned); joined_at NULL (or
//     unparseable) sorts last; lowest participant id breaks ties.
//   - Only the LAST active admin triggers a handoff. Any other active admin
//     (banned or not) means nobody is promoted.
//   - Leave: promote the oldest eligible member and move the owner to them;
//     archive only when nobody is eligible. Delete: same promotion, but never
//     archive (nobody eligible = no-op).
//   - Delete only: a departing CREATOR with other active admins left hands
//     created_by_id to the oldest remaining admin (non-banned first).
//   - Archived groups and non-groups are never touched.
//   - Leave only: a departing admin is demoted to member with the leave.
//
// Usage (from tribelife-backend/): node --no-warnings scripts/verify-admin-handoff.mjs
//   Optional arg: [path/to/adminHandoffRules.ts], resolved against the current
//   working directory. Default is relative to this script
//   (tribelife-backend/scripts/). Requires Node v22.18+ (built-in TypeScript
//   type stripping). Same .mjs rationale as scripts/verify-shabbat-rollover.mjs.
//
// Planner-authored gate for quick task 261003-vpp. The committed copy in
// tribelife-backend/scripts/ must stay byte-identical to the planning copy.
// Prints ADMIN_HANDOFF_OK on success, ADMIN_HANDOFF_FAIL <case...> otherwise.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const modPath = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(here, '../src/utils/adminHandoffRules.ts');
const fails = [];
const ok = (c, n) => { if (!c) fails.push(n); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const src = fs.readFileSync(modPath, 'utf8');
ok(!/^\s*import\s/m.test(src) && !/require\(/.test(src), 'pure');
const M = await import(pathToFileURL(modPath).href);
const fns = ['tenureTime', 'compareTenure', 'isActiveParticipant', 'isActiveAdmin', 'isPromotionEligible',
  'rankPromotionCandidates', 'pickNextAdmin', 'pickSuccessorOwner', 'planGroupHandoff'];
ok(fns.every((f) => typeof M[f] === 'function'), 'exports');
if (fails.length) { console.log('ADMIN_HANDOFF_FAIL ' + fails.join(' ')); process.exit(1); }

ok(M.HANDOFF_PROMOTE_ATTEMPTS === 3 && M.HANDOFF_MAX_GROUPS_PER_DELETION === 100 && M.HANDOFF_DELETION_BUDGET_MS === 8000, 'const');

// ── fixtures ────────────────────────────────────────────────────────────────
const P = (participantId, userId, role, joinedAt, extra = {}) =>
  ({ participantId, userId, role, joinedAt, leftAt: null, banned: false, ...extra });
const G = (extra = {}) => ({ isGroup: true, archivedAt: null, createdById: 1, ...extra });
const plan = (mode, departingUserId, participants, group = G()) =>
  M.planGroupHandoff({ mode, departingUserId, group, participants });
const ids = (arr) => arr.map((p) => p.userId);
const rank = (list, departing = 1) => ids(M.rankPromotionCandidates(list, departing));
const LEFT = { leftAt: new Date('2026-09-01T00:00:00Z') };
const T = '2025-04-01T00:00:00Z';

// ── tenure ordering ─────────────────────────────────────────────────────────
ok(M.tenureTime(null) === null && M.tenureTime(undefined) === null && M.tenureTime('not-a-date') === null
  && M.tenureTime(new Date(0)) === 0 && M.tenureTime('2026-01-01T00:00:00Z') === Date.parse('2026-01-01T00:00:00Z')
  && M.tenureTime(1700000000000) === 1700000000000, 'tenure:parse');
ok(eq(rank([P(11, 2, 'member', '2026-03-01T00:00:00Z'), P(12, 3, 'member', '2026-01-01T00:00:00Z'), P(13, 4, 'member', '2026-02-01T00:00:00Z')]), [3, 4, 2]), 'rank:oldest');
ok(M.pickNextAdmin([P(11, 2, 'member', '2026-03-01T00:00:00Z'), P(12, 3, 'member', '2026-01-01T00:00:00Z')], 1).userId === 3, 'pick:oldest');
ok(eq(rank([P(5, 2, 'member', null), P(9, 3, 'member', '2026-05-01T00:00:00Z')]), [3, 2]), 'rank:nulls-last');
ok(eq(rank([P(5, 2, 'member', 'not-a-date'), P(9, 3, 'member', '2026-05-01T00:00:00Z')]), [3, 2]), 'rank:invalid-last');
ok(eq(rank([P(20, 2, 'member', T), P(10, 3, 'member', T)]), [3, 2]), 'rank:id-tiebreak');
ok(eq(rank([P(30, 4, 'member', null), P(25, 5, 'member', null)]), [5, 4]), 'rank:id-tiebreak-nulls');
ok(eq(rank([P(1, 2, 'member', new Date('2026-04-01T00:00:00Z')), P(2, 3, 'member', '2026-03-01T00:00:00Z'), P(3, 4, 'member', Date.parse('2026-02-01T00:00:00Z'))]), [4, 3, 2]), 'rank:types');
{
  const input = [P(13, 4, 'member', '2026-02-01T00:00:00Z'), P(11, 2, 'member', '2026-03-01T00:00:00Z'), P(12, 3, 'member', '2026-01-01T00:00:00Z'), P(10, 1, 'admin', '2025-01-01T00:00:00Z')];
  const before = ids(input);
  M.rankPromotionCandidates(input, 1);
  M.pickNextAdmin(input, 1);
  M.pickSuccessorOwner(input, 99);
  plan('leave', 1, input);
  plan('delete', 1, input);
  ok(eq(ids(input), before), 'pure:no-mutate');
}

// ── eligibility ─────────────────────────────────────────────────────────────
ok(!M.isPromotionEligible(P(1, 2, 'kicked', T)) && !M.isPromotionEligible(P(1, 2, 'kicked', T, LEFT)) && !M.isActiveParticipant(P(1, 2, 'kicked', T)), 'elig:kicked');
ok(!M.isPromotionEligible(P(1, 2, 'member', T, LEFT)) && !M.isActiveParticipant(P(1, 2, 'member', T, LEFT)), 'elig:left');
ok(!M.isPromotionEligible(P(1, 2, 'member', T, { banned: true })), 'elig:banned');
ok(!M.isPromotionEligible(P(1, 2, 'admin', T)) && M.isActiveAdmin(P(1, 2, 'admin', T)) && !M.isActiveAdmin(P(1, 2, 'admin', T, LEFT)), 'elig:admin');
ok(M.isPromotionEligible(P(1, 2, null, T)) && M.isPromotionEligible(P(1, 2, 'member', T)), 'elig:member-or-null');
ok(eq(rank([P(1, 7, 'member', '2020-01-01T00:00:00Z'), P(2, 8, 'member', '2021-01-01T00:00:00Z')], 7), [8]), 'elig:departing');
ok(eq(rank([
  P(1, 1, 'admin', '2019-01-01T00:00:00Z'),
  P(2, 2, 'kicked', '2019-02-01T00:00:00Z', LEFT),
  P(3, 3, 'member', '2019-03-01T00:00:00Z', LEFT),
  P(4, 4, 'member', '2019-04-01T00:00:00Z', { banned: true }),
  P(5, 5, 'member', '2026-01-01T00:00:00Z'),
]), [5]), 'elig:mix');

// ── leave ───────────────────────────────────────────────────────────────────
const A = P(100, 1, 'admin', '2025-01-01T00:00:00Z');   // departing admin + creator (createdById 1)
const B = P(101, 2, 'member', '2025-02-01T00:00:00Z');  // older member
const C = P(102, 3, 'member', '2025-03-01T00:00:00Z');  // newer member
const D = P(103, 4, 'admin', '2025-06-01T00:00:00Z');   // another admin (newer)
const E = P(104, 5, 'admin', '2025-01-15T00:00:00Z');   // another admin (older)
const KEYS = ['archive', 'candidates', 'demoteDeparting', 'newOwnerId', 'reason'];
{
  const p = plan('leave', 1, [C, A, B]);
  ok(eq(Object.keys(p).sort(), KEYS), 'plan:shape');
  ok(p.reason === 'promoted' && eq(ids(p.candidates), [2, 3]) && p.newOwnerId === 2 && p.archive === false && p.demoteDeparting === true, 'leave:promote');
}
ok(plan('leave', 1, [A, B, C], G({ createdById: 999 })).newOwnerId === 2 && plan('leave', 1, [A, B, C], G({ createdById: null })).newOwnerId === 2, 'leave:owner-moves');
{
  const p = plan('leave', 1, [A, B, C, D]);
  ok(p.reason === 'other-admin' && p.candidates.length === 0 && p.newOwnerId === null && p.archive === false && p.demoteDeparting === true, 'leave:other-admin');
}
ok(plan('leave', 1, [A, B, C, { ...D, banned: true }]).reason === 'other-admin', 'leave:other-admin-banned');
ok(plan('leave', 1, [A, B, C, { ...D, ...LEFT }]).reason === 'promoted', 'leave:other-admin-left');
{
  const p = plan('leave', 1, [A]);
  ok(p.reason === 'archive' && p.archive === true && p.candidates.length === 0 && p.newOwnerId === null && p.demoteDeparting === true, 'leave:archive-alone');
}
ok(plan('leave', 1, [A, P(201, 6, 'kicked', T, LEFT), P(202, 7, 'member', T, LEFT), P(203, 8, 'member', T, { banned: true })]).archive === true, 'leave:archive-ineligible');
{
  const p = plan('leave', 2, [A, B, C]);
  ok(p.reason === 'not-admin' && p.archive === false && p.newOwnerId === null && p.candidates.length === 0 && p.demoteDeparting === false, 'leave:member');
}
ok(plan('leave', 42, [A, B]).reason === 'not-admin' && plan('leave', 42, [A, B]).demoteDeparting === false, 'leave:not-member');
{
  const p = plan('leave', 1, [{ ...A, ...LEFT }, B]);
  ok(p.reason === 'not-admin' && p.demoteDeparting === false && p.archive === false, 'leave:already-left');
}

// ── delete ──────────────────────────────────────────────────────────────────
{
  const p = plan('delete', 1, [A, B, C]);
  ok(p.reason === 'promoted' && eq(ids(p.candidates), [2, 3]) && p.newOwnerId === 2 && p.archive === false && p.demoteDeparting === false, 'delete:promote');
}
ok(plan('delete', 1, [A, B, C], G({ createdById: 999 })).newOwnerId === 2, 'delete:owner-moves');
{
  const p = plan('delete', 1, [A]);
  const q = plan('delete', 1, [A, P(201, 6, 'kicked', T, LEFT), P(203, 8, 'member', T, { banned: true })]);
  ok(p.reason === 'no-eligible' && p.archive === false && p.newOwnerId === null && q.reason === 'no-eligible' && q.archive === false, 'delete:no-eligible');
}
{
  const p = plan('delete', 1, [A, B, D, E]);
  ok(p.reason === 'owner-transfer' && p.newOwnerId === 5 && p.candidates.length === 0 && p.archive === false, 'delete:owner-transfer');
}
ok(plan('delete', 1, [A, B, D, { ...E, banned: true }]).newOwnerId === 4, 'delete:owner-banned-last');
ok(plan('delete', 1, [A, B, { ...E, banned: true }]).newOwnerId === 5, 'delete:owner-banned-only');
ok(plan('delete', 1, [A, P(301, 9, 'admin', T), P(300, 10, 'admin', T)]).newOwnerId === 10, 'delete:owner-id-tiebreak');
{
  const p = plan('delete', 1, [{ ...A, ...LEFT }, B, D]);
  ok(p.reason === 'owner-transfer' && p.newOwnerId === 4, 'delete:creator-left');
}
{
  const p = plan('delete', 1, [{ ...A, ...LEFT }, B, C]);
  ok(p.reason === 'not-admin' && p.newOwnerId === null && p.candidates.length === 0 && p.archive === false, 'delete:creator-left-no-admin');
}
{
  const p = plan('delete', 1, [A, B, D], G({ createdById: 999 }));
  ok(p.reason === 'other-admin' && p.newOwnerId === null && p.candidates.length === 0, 'delete:admin-not-creator');
}
ok(plan('delete', 2, [A, B, C], G({ createdById: 2 })).reason === 'owner-transfer' && plan('delete', 2, [A, B, C], G({ createdById: 2 })).newOwnerId === 1, 'delete:member-creator');
ok(plan('delete', 2, [A, B, C]).reason === 'not-admin' && plan('delete', 2, [A, B, C]).newOwnerId === null, 'delete:member');

// ── group gates ─────────────────────────────────────────────────────────────
{
  const g = G({ archivedAt: new Date('2026-08-01T00:00:00Z') });
  const l = plan('leave', 1, [A, B, C], g);
  const d = plan('delete', 1, [A, B, D, E], g);
  ok(l.reason === 'archived' && l.candidates.length === 0 && l.newOwnerId === null && l.archive === false && l.demoteDeparting === true
    && d.reason === 'archived' && d.newOwnerId === null && d.archive === false && d.demoteDeparting === false, 'group:archived');
}
ok(['leave', 'delete'].every((m) => [G({ isGroup: null }), G({ isGroup: false }), null, undefined].every((g) => {
  const p = M.planGroupHandoff({ mode: m, departingUserId: 1, group: g, participants: [A, B, C] });
  return p.reason === 'not-group' && p.candidates.length === 0 && p.newOwnerId === null && p.archive === false;
})), 'group:not-group');
ok(M.pickNextAdmin([A], 1) === null && M.pickSuccessorOwner([A, B], 1) === null, 'pick:none');

if (fails.length) { console.log('ADMIN_HANDOFF_FAIL ' + fails.join(' ')); process.exit(1); }
console.log('ADMIN_HANDOFF_OK');
