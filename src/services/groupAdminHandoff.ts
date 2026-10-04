import { and, eq, isNull, or, notInArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema';
import { conversations, conversationParticipants, users } from '../db/schema';
import {
  planGroupHandoff,
  HANDOFF_PROMOTE_ATTEMPTS,
  type HandoffMode,
  type HandoffReason,
  type HandoffParticipant,
} from '../utils/adminHandoffRules';

// The DB side of the group admin handoff (quick 261003-vpp). The rules live in
// utils/adminHandoffRules.ts, and every query here runs on the caller's
// transaction so the handoff commits or rolls back together with the leave.

// Anything queries can run on: the module-level `db` or the `tx` handed to
// db.transaction(async (tx) => ...). Same pattern as services/referralCredit.ts.
export type GroupHandoffExecutor = NodePgDatabase<typeof schema>;

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
