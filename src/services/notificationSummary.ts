import { and, eq, exists, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  notifications,
  conversationParticipants,
  conversations,
  messages,
} from '../db/schema';

// ── Bell summary — SINGLE SOURCE OF TRUTH (v1.13 Phase 1 #2) ─────────────────
// The four "bell" buckets shown on the notifications tab. Both GET
// /api/notifications/summary AND the push app-icon badge derive from here so the
// number the push sets on the OS badge and the number the app syncs to can never
// diverge (that divergence — plus a reactive-only setBadgeCountAsync on mobile —
// was the "badge only clears on app restart" bug).
//
// Buckets are deliberately DEDUPED per-conversation (one per group chat / one per
// 1:1 DM), NOT per-message, so a chatty room can't inflate the badge. Types NOT
// in a bucket (org_invite, news_breaking, …) are intentionally EXCLUDED from the
// badge — a product decision to keep the badge a "someone's trying to reach me"
// signal. Revisit when onboarding orgs.
export interface BellSummary {
  groups: number; // distinct group chats with ≥1 unread type:'group' row
  dms: number; // unread 'mention' rows + distinct 1:1 DMs with unread messages
  matches: number; // unread 'beacon_match' rows
  system: number; // unread 'system' rows
}

const EMPTY: BellSummary = { groups: 0, dms: 0, matches: 0, system: 0 };

/** Sum of the four bell buckets — the app-icon badge value. */
export function bellTotal(s: BellSummary): number {
  return s.groups + s.dms + s.matches + s.system;
}

/**
 * Bell summary for one user. Mirrors the (previously inline) GET /summary query.
 * groups = distinct entityIds with an unread type:'group' row (one per chat).
 * dms    = unread 'mention' rows + distinct 1:1 conversations with an unread
 *          message newer than the user's lastReadAt (and not authored by them).
 */
export async function getBellSummary(userId: number): Promise<BellSummary> {
  const [notifRow] = await db
    .select({
      mentions: sql<number>`count(*) filter (where ${notifications.type} = 'mention' and ${notifications.isRead} = false)`.mapWith(Number),
      matches: sql<number>`count(*) filter (where ${notifications.type} = 'beacon_match' and ${notifications.isRead} = false)`.mapWith(Number),
      system: sql<number>`count(*) filter (where ${notifications.type} = 'system' and ${notifications.isRead} = false)`.mapWith(Number),
      groups: sql<number>`count(distinct (${notifications.data}->>'entityId')) filter (where ${notifications.type} = 'group' and ${notifications.isRead} = false)`.mapWith(Number),
    })
    .from(notifications)
    .where(eq(notifications.userId, userId));

  const [dmConvRow] = await db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(conversationParticipants)
    .where(and(
      eq(conversationParticipants.userId, userId),
      exists(
        db
          .select({ id: conversations.id })
          .from(conversations)
          .where(and(
            eq(conversations.id, conversationParticipants.conversationId),
            sql`${conversations.isGroup} IS NOT TRUE`,
          )),
      ),
      exists(
        db
          .select({ id: messages.id })
          .from(messages)
          .where(and(
            eq(messages.conversationId, conversationParticipants.conversationId),
            ne(messages.senderId, userId),
            or(
              isNull(conversationParticipants.lastReadAt),
              gt(messages.createdAt, conversationParticipants.lastReadAt),
            ),
          )),
      ),
    ));

  return {
    groups: notifRow?.groups ?? 0,
    dms: (notifRow?.mentions ?? 0) + (dmConvRow?.count ?? 0),
    matches: notifRow?.matches ?? 0,
    system: notifRow?.system ?? 0,
  };
}

/**
 * Batched bell summary for many users (group/room/globe fan-out badge path).
 * Two grouped queries instead of N×2 — the deduped summary is heavier than a raw
 * unread-row count, so batching matters on the hot send path. Users with no rows
 * in a query default to zero for that bucket. Returns an entry for EVERY input
 * userId (including all-zero) so callers can send an explicit badge:0 to clear.
 */
export async function getBellSummaries(userIds: number[]): Promise<Map<number, BellSummary>> {
  const out = new Map<number, BellSummary>();
  if (userIds.length === 0) return out;

  const notifRows = await db
    .select({
      userId: notifications.userId,
      mentions: sql<number>`count(*) filter (where ${notifications.type} = 'mention' and ${notifications.isRead} = false)`.mapWith(Number),
      matches: sql<number>`count(*) filter (where ${notifications.type} = 'beacon_match' and ${notifications.isRead} = false)`.mapWith(Number),
      system: sql<number>`count(*) filter (where ${notifications.type} = 'system' and ${notifications.isRead} = false)`.mapWith(Number),
      groups: sql<number>`count(distinct (${notifications.data}->>'entityId')) filter (where ${notifications.type} = 'group' and ${notifications.isRead} = false)`.mapWith(Number),
    })
    .from(notifications)
    .where(inArray(notifications.userId, userIds))
    .groupBy(notifications.userId);

  const dmRows = await db
    .select({
      userId: conversationParticipants.userId,
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(conversationParticipants)
    .where(and(
      inArray(conversationParticipants.userId, userIds),
      exists(
        db
          .select({ id: conversations.id })
          .from(conversations)
          .where(and(
            eq(conversations.id, conversationParticipants.conversationId),
            sql`${conversations.isGroup} IS NOT TRUE`,
          )),
      ),
      exists(
        db
          .select({ id: messages.id })
          .from(messages)
          .where(and(
            eq(messages.conversationId, conversationParticipants.conversationId),
            ne(messages.senderId, conversationParticipants.userId),
            or(
              isNull(conversationParticipants.lastReadAt),
              gt(messages.createdAt, conversationParticipants.lastReadAt),
            ),
          )),
      ),
    ))
    .groupBy(conversationParticipants.userId);

  const notifByUser = new Map(notifRows.map((r) => [r.userId, r]));
  const dmByUser = new Map(dmRows.map((r) => [r.userId, r.count]));

  for (const uid of userIds) {
    const n = notifByUser.get(uid);
    const dmConvs = dmByUser.get(uid) ?? 0;
    out.set(uid, {
      groups: n?.groups ?? 0,
      dms: (n?.mentions ?? 0) + dmConvs,
      matches: n?.matches ?? 0,
      system: n?.system ?? 0,
    });
  }
  return out;
}

export { EMPTY as EMPTY_BELL_SUMMARY };
