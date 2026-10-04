import { and, eq, isNull, or, notInArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { db } from '../db';
import * as schema from '../db/schema';
import { conversations, conversationParticipants, users } from '../db/schema';
import logger from '../lib/logger';
import {
  planGroupHandoff,
  HANDOFF_PROMOTE_ATTEMPTS,
  HANDOFF_MAX_GROUPS_PER_DELETION,
  HANDOFF_DELETION_BUDGET_MS,
  type HandoffMode,
  type HandoffReason,
  type HandoffParticipant,
} from '../utils/adminHandoffRules';

// The DB side of the group admin handoff (quick 261003-vpp). The rules live in
// utils/adminHandoffRules.ts, and every query here runs on the caller's
// transaction so the handoff commits or rolls back together with the leave.

const log = logger.child({ module: 'group-handoff' });

// Anything queries can run on: the module-level `db` or the `tx` handed to
// db.transaction(async (tx) => ...). Same pattern as services/referralCredit.ts.
export type GroupHandoffExecutor = NodePgDatabase<typeof schema>;

export type DeletionHandoffSummary = { considered: number; promoted: number; ownerTransfers: number; unchanged: number; failed: number; skipped: number };

export type GroupHandoffResult = {
  reason: HandoffReason;
  promotedUserId: number | null;
  newOwnerId: number | null;
  archived: boolean;
  demoteDeparting: boolean;
};

/**
 * Decide and apply the handoff for one group on the caller's transaction.
 * Never writes the departing user's own participant row; the caller does that.
 */
export async function runGroupAdminHandoff(
  tx: GroupHandoffExecutor,
  input: { conversationId: number; departingUserId: number; mode: HandoffMode },
): Promise<GroupHandoffResult> {
  const { conversationId, departingUserId, mode } = input;

  // PD-4: lock the conversations row so concurrent leaves/handoffs of the same
  // group serialize (the second waits, then sees the first gone). NO KEY UPDATE,
  // not FOR UPDATE: FOR UPDATE would also block message and participant inserts,
  // whose FK checks take KEY SHARE on this row.
  const [group] = await tx
    .select({
      isGroup: conversations.isGroup,
      archivedAt: conversations.archivedAt,
      createdById: conversations.createdById,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .for('no key update');

  let participants: HandoffParticipant[] = [];
  if (group) {
    // Active participants only; the rules module does the ranking (PD-1). Groups
    // are capped at 1000 members, so this load is bounded.
    const rows = await tx
      .select({
        participantId: conversationParticipants.id,
        userId: conversationParticipants.userId,
        role: conversationParticipants.role,
        joinedAt: conversationParticipants.joinedAt,
        leftAt: conversationParticipants.leftAt,
        bannedAt: users.bannedAt,
      })
      .from(conversationParticipants)
      .innerJoin(users, eq(users.id, conversationParticipants.userId))
      .where(and(
        eq(conversationParticipants.conversationId, conversationId),
        isNull(conversationParticipants.leftAt),
      ));
    participants = rows.map((row) => ({
      participantId: row.participantId,
      userId: row.userId,
      role: row.role,
      joinedAt: row.joinedAt,
      leftAt: row.leftAt,
      banned: row.bannedAt != null,
    }));
  }

  const plan = planGroupHandoff({
    mode,
    departingUserId,
    group: group ?? null,
    participants,
  });

  let promotedUserId: number | null = null;
  let newOwnerId: number | null = null;
  let archived = false;

  if (plan.reason === 'promoted') {
    // The UPDATE re-checks left_at / role, because kick, join and the user-delete
    // cascade do not take the conversation lock. If a candidate vanished, try the
    // next ranked one (bounded); if none works, roll the whole transaction back.
    for (const candidate of plan.candidates.slice(0, HANDOFF_PROMOTE_ATTEMPTS)) {
      const updated = await tx
        .update(conversationParticipants)
        .set({ role: 'admin' })
        .where(and(
          eq(conversationParticipants.id, candidate.participantId),
          isNull(conversationParticipants.leftAt),
          or(
            isNull(conversationParticipants.role),
            notInArray(conversationParticipants.role, ['admin', 'kicked']),
          ),
        ))
        .returning({ id: conversationParticipants.id });
      if (updated.length > 0) {
        promotedUserId = candidate.userId;
        break;
      }
    }
    if (promotedUserId === null) {
      throw new Error('[group-handoff] no candidate could be promoted');
    }
    // D3: the owner follows the handoff, including when a fallback candidate won.
    await tx
      .update(conversations)
      .set({ createdById: promotedUserId })
      .where(eq(conversations.id, conversationId));
    newOwnerId = promotedUserId;
  } else if (plan.reason === 'archive') {
    await tx
      .update(conversations)
      .set({ archivedAt: new Date() })
      .where(and(eq(conversations.id, conversationId), isNull(conversations.archivedAt)));
    archived = true;
  } else if (plan.reason === 'owner-transfer' && plan.newOwnerId !== null) {
    await tx
      .update(conversations)
      .set({ createdById: plan.newOwnerId })
      .where(eq(conversations.id, conversationId));
    newOwnerId = plan.newOwnerId;
  }

  return {
    reason: plan.reason,
    promotedUserId,
    newOwnerId,
    archived,
    demoteDeparting: plan.demoteDeparting,
  };
}

/**
 * Hand admin and ownership of the user's groups to real members BEFORE their
 * account is deleted. It must run before the users delete, because the user's
 * participant rows cascade away with the user, so the plan has to see them first.
 *
 * Best-effort and NEVER throws: anything it does not hand off is covered by the
 * c284830 join safety net (a group with no owner can still be joined) and by the
 * one-time backfill. Account deletion is an App Store requirement and must not
 * be blocked by group housekeeping.
 */
export async function handOffGroupsForDeletedUser(userId: number): Promise<DeletionHandoffSummary> {
  const summary: DeletionHandoffSummary = {
    considered: 0,
    promoted: 0,
    ownerTransfers: 0,
    unchanged: 0,
    failed: 0,
    skipped: 0,
  };

  try {
    // Archived groups are never read (D5), so they can never fail the deletion.
    const created = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(
        eq(conversations.createdById, userId),
        eq(conversations.isGroup, true),
        isNull(conversations.archivedAt),
      ));

    const administered = await db
      .select({ id: conversations.id })
      .from(conversationParticipants)
      .innerJoin(conversations, eq(conversations.id, conversationParticipants.conversationId))
      .where(and(
        eq(conversationParticipants.userId, userId),
        eq(conversationParticipants.role, 'admin'),
        isNull(conversationParticipants.leftAt),
        eq(conversations.isGroup, true),
        isNull(conversations.archivedAt),
      ));

    let ids = Array.from(new Set([...created, ...administered].map((r) => r.id))).sort((a, b) => a - b);

    if (ids.length > HANDOFF_MAX_GROUPS_PER_DELETION) {
      log.warn(
        { userId, total: ids.length, cap: HANDOFF_MAX_GROUPS_PER_DELETION },
        '[auth/account] too many groups to hand off; the rest are left to the backfill',
      );
      summary.skipped += ids.length - HANDOFF_MAX_GROUPS_PER_DELETION;
      ids = ids.slice(0, HANDOFF_MAX_GROUPS_PER_DELETION);
    }

    // Sequential, one transaction each: the handoff holds one pooled connection
    // at a time (the pool max is 20).
    const deadline = Date.now() + HANDOFF_DELETION_BUDGET_MS;
    for (let i = 0; i < ids.length; i++) {
      const conversationId = ids[i];
      if (Date.now() > deadline) {
        const remaining = ids.length - i;
        summary.skipped += remaining;
        log.warn(
          { userId, remaining },
          '[auth/account] group admin handoff ran out of time; the rest are left to the backfill',
        );
        break;
      }
      summary.considered++;
      try {
        const result = await db.transaction((tx) =>
          runGroupAdminHandoff(tx, { conversationId, departingUserId: userId, mode: 'delete' }),
        );
        if (result.promotedUserId !== null) {
          summary.promoted++;
        } else if (result.reason === 'owner-transfer') {
          summary.ownerTransfers++;
        } else {
          summary.unchanged++;
        }
      } catch (err) {
        summary.failed++;
        log.error(
          { err, userId, conversationId },
          '[auth/account] group admin handoff failed; continuing with deletion',
        );
      }
    }
  } catch (err) {
    log.error(
      { err, userId },
      '[auth/account] group admin handoff lookup failed; continuing with deletion',
    );
  }

  return summary;
}
