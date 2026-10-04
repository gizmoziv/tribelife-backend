// Group admin handoff rules — the single source of who is eligible, who is next,
// when to archive and where the owner moves. Shared by the leave route and by
// account deletion (quick 261003-vpp).
//
// This file has ZERO imports so scripts/verify-admin-handoff.mjs can test it in
// plain Node. The one-time backfill SQL in the 261003-vpp SUMMARY mirrors these
// rules; change both together.

export const HANDOFF_PROMOTE_ATTEMPTS = 3;
export const HANDOFF_MAX_GROUPS_PER_DELETION = 100;
export const HANDOFF_DELETION_BUDGET_MS = 8000;

export type HandoffMode = 'leave' | 'delete';

export type HandoffTime = Date | string | number | null | undefined;

export type HandoffParticipant = {
  participantId: number;
  userId: number;
  role: string | null;
  joinedAt: HandoffTime;
  leftAt: HandoffTime;
  banned: boolean;
};

export type HandoffGroup = {
  isGroup: boolean | null;
  archivedAt: HandoffTime;
  createdById: number | null;
};

export type HandoffReason =
  | 'not-group'
  | 'archived'
  | 'not-admin'
  | 'other-admin'
  | 'owner-transfer'
  | 'promoted'
  | 'archive'
  | 'no-eligible';

export type HandoffPlan = {
  reason: HandoffReason;
  candidates: HandoffParticipant[];
  newOwnerId: number | null;
  archive: boolean;
  demoteDeparting: boolean;
};

// ── Ordering ────────────────────────────────────────────────────────────────

/** Milliseconds since epoch, or null when the value is missing or unparseable. */
export function tenureTime(t: HandoffTime): number | null {
  if (t === null || t === undefined) return null;
  const ms = t instanceof Date ? t.getTime() : new Date(t).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Ascending by joinedAt; a missing time sorts after every real time; ties by participant id. */
export function compareTenure(a: HandoffParticipant, b: HandoffParticipant): number {
  const ta = tenureTime(a.joinedAt);
  const tb = tenureTime(b.joinedAt);
  if (ta !== tb) {
    if (ta === null) return 1;
    if (tb === null) return -1;
    return ta - tb;
  }
  return a.participantId - b.participantId;
}

// ── Eligibility ─────────────────────────────────────────────────────────────

export function isActiveParticipant(p: HandoffParticipant): boolean {
  return p.leftAt == null && p.role !== 'kicked';
}

export function isActiveAdmin(p: HandoffParticipant): boolean {
  return isActiveParticipant(p) && p.role === 'admin';
}

// A null role counts as a plain member (the column is nullable, default 'member').
export function isPromotionEligible(p: HandoffParticipant): boolean {
  return isActiveParticipant(p) && p.role !== 'admin' && p.banned !== true;
}

// ── Picks (always return new arrays; never mutate the input) ────────────────

export function rankPromotionCandidates(
  participants: readonly HandoffParticipant[],
  departingUserId: number,
): HandoffParticipant[] {
  return participants
    .filter((p) => p.userId !== departingUserId && isPromotionEligible(p))
    .sort(compareTenure);
}

export function pickNextAdmin(
  participants: readonly HandoffParticipant[],
  departingUserId: number,
): HandoffParticipant | null {
  return rankPromotionCandidates(participants, departingUserId)[0] ?? null;
}

// Owner among the remaining admins: non-banned first, then the tenure order, so
// created_by_id is never left NULL while any admin exists.
export function pickSuccessorOwner(
  participants: readonly HandoffParticipant[],
  departingUserId: number,
): HandoffParticipant | null {
  const admins = participants
    .filter((p) => p.userId !== departingUserId && isActiveAdmin(p))
    .sort((a, b) => {
      if (a.banned !== b.banned) return a.banned ? 1 : -1;
      return compareTenure(a, b);
    });
  return admins[0] ?? null;
}

// ── Plan ────────────────────────────────────────────────────────────────────

export function planGroupHandoff(input: {
  mode: HandoffMode;
  departingUserId: number;
  group: HandoffGroup | null | undefined;
  participants: readonly HandoffParticipant[];
}): HandoffPlan {
  const { mode, departingUserId, group, participants } = input;

  const departing =
    participants.find((p) => p.userId === departingUserId && isActiveParticipant(p)) ?? null;
  const departingIsAdmin = departing !== null && departing.role === 'admin';
  const demoteDeparting = mode === 'leave' && departingIsAdmin;

  const noop = (reason: HandoffReason): HandoffPlan => ({
    reason,
    candidates: [],
    newOwnerId: null,
    archive: false,
    demoteDeparting,
  });

  if (!group || group.isGroup !== true) return noop('not-group');
  if (group.archivedAt != null) return noop('archived');

  // Banned admins still count as "another active admin" (a ban is not a trigger).
  const otherAdmins = participants.filter(
    (p) => p.userId !== departingUserId && isActiveAdmin(p),
  );

  if (departingIsAdmin && otherAdmins.length === 0) {
    const candidates = rankPromotionCandidates(participants, departingUserId);
    if (candidates.length > 0) {
      return {
        reason: 'promoted',
        candidates,
        newOwnerId: candidates[0].userId,
        archive: false,
        demoteDeparting,
      };
    }
    if (mode === 'leave') return { ...noop('archive'), archive: true };
    return noop('no-eligible');
  }

  if (mode === 'delete' && group.createdById === departingUserId && otherAdmins.length > 0) {
    const successor = pickSuccessorOwner(participants, departingUserId);
    return { ...noop('owner-transfer'), newOwnerId: successor ? successor.userId : null };
  }

  return noop(departingIsAdmin ? 'other-admin' : 'not-admin');
}
