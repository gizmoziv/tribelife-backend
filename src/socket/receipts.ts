import { Server } from 'socket.io';
import { db } from '../db';
import { conversationParticipants, conversations, messages, notificationPreferences } from '../db/schema';
import { and, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';

// ── Read-receipt helper layer (Phase 28) ─────────────────────────────────────
// Centralizes the two primitives every receipt emission site depends on so the
// privacy gate and cross-pod online-detection logic cannot drift between the
// multiple call sites added in later waves (live delivery emit, reconnect
// back-fill, read emit). This module is the SKELETON — Wave 2 (plan 28-02) adds
// emitDeliveredOnSend / backfillDeliveryOnConnect on top of these helpers.

/**
 * Cross-pod online detection: returns the subset of `userIds` that currently
 * hold at least one live socket, cluster-wide.
 *
 * Uses `io.in('user:'+id).fetchSockets()` (cross-pod via the Redis adapter in
 * production) — never the local-pod-only adapter room map, which undercounts
 * under horizontal scaling (documented in activeViewing.ts).
 *
 * The predicate is presence-only (`sockets.length > 0`), NOT the
 * `isForeground && activeRoomKey` predicate isUserActivelyViewing uses — a
 * backgrounded but connected device still counts as "delivered".
 *
 * The per-id round-trips are parallelized with `Promise.all` (NOT a serial
 * for-await loop) so N recipients cost ~1 round-trip of wall-time, not N — the
 * fetchSockets-scaling recommendation from RESEARCH.
 */
export async function getOnlineUserIds(io: Server, userIds: number[]): Promise<Set<number>> {
  const online = new Set<number>();
  await Promise.all(
    userIds.map(async (id) => {
      const sockets = await io.in(`user:${id}`).fetchSockets();
      if (sockets.length > 0) online.add(id);
    }),
  );
  return online;
}

/**
 * Reciprocal read-receipt privacy gate (PRIV-01, PRIV-02): true only when BOTH
 * users `a` and `b` allow read receipts. Used to gate DM `message:read` emission
 * in both directions — a user with receipts OFF neither sends nor sees reads.
 *
 * A user with no `notification_preferences` row defaults to ON (`?? true`),
 * mirroring shouldSendPush's `if (!prefs) return true` semantics. Group reads
 * are NEVER gated by this helper (PRIV-04) and delivered is NEVER gated (PRIV-03).
 */
export async function bothAllowReadReceipts(a: number, b: number): Promise<boolean> {
  const rows = await db
    .select({
      userId: notificationPreferences.userId,
      readReceipts: notificationPreferences.readReceipts,
    })
    .from(notificationPreferences)
    .where(inArray(notificationPreferences.userId, [a, b]));
  const map = new Map(rows.map((r) => [r.userId, r.readReceipts]));
  // missing row → default true (receipts ON), matching shouldSendPush
  return (map.get(a) ?? true) && (map.get(b) ?? true);
}

/**
 * Emitted to the message author's `user:<senderId>` room when a recipient's
 * delivery watermark advances. `userId` carries the RECIPIENT (never the sender)
 * so Phase 29 can build per-member "Delivered to N" (D-01a, D-02).
 */
export interface MessageDeliveredPayload {
  conversationId: number;
  /** The recipient whose lastDeliveredAt advanced (NOT the sender). */
  userId: number;
  /** ISO timestamp the recipient's delivery watermark advanced to. */
  deliveredUpTo: string;
}

/**
 * Emitted to the message author's `user:<senderId>` room when a reader's read
 * watermark advances. `userId` carries the READER (never the sender) so Phase 29
 * can build per-member "Seen by N" (D-01a, D-02).
 */
export interface MessageReadPayload {
  conversationId: number;
  /** The reader whose lastReadAt advanced (NOT the sender). */
  userId: number;
  /** ISO timestamp the reader's read watermark advanced to. */
  readUpTo: string;
}

/**
 * Live delivery emit on the message send path (RCPT-02, RCPT-06, PRIV-03).
 *
 * Called AFTER the message broadcast on BOTH DM send paths (`dm:message` and
 * `dm:voice`). `recipientIds` is the already-sender-excluded participant set the
 * caller passes (Pitfall 1 — never re-include the author).
 *
 * Detects which recipients hold a live socket cluster-wide (cross-pod
 * `getOnlineUserIds`); for those, advances ONLY their `lastDeliveredAt` watermark
 * and emits `message:delivered` to the SENDER's `user:<senderId>` room carrying the
 * recipient's per-member watermark advance. If no recipient is online, returns early
 * — the back-fill on that recipient's reconnect handles delivery later (D-04).
 *
 * Delivered is NEVER gated on privacy (PRIV-03) — no `readReceipts` check here.
 * Emits ONLY to `user:<senderId>`, never the conversation room (would leak state).
 */
export async function emitDeliveredOnSend(
  io: Server,
  conversationId: number,
  senderId: number,
  recipientIds: number[],
): Promise<void> {
  if (recipientIds.length === 0) return;
  const online = await getOnlineUserIds(io, recipientIds);
  if (online.size === 0) return; // all recipients offline → back-fill on their reconnect

  const now = new Date();
  await db
    .update(conversationParticipants)
    .set({ lastDeliveredAt: now })
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        inArray(conversationParticipants.userId, [...online]),
      ),
    );

  const deliveredUpTo = now.toISOString();
  for (const recipientId of online) {
    io.to(`user:${senderId}`).emit('message:delivered', {
      conversationId,
      userId: recipientId,
      deliveredUpTo,
    } satisfies MessageDeliveredPayload);
  }
}

/**
 * Reconnect back-fill (RCPT-02, D-04). Called inside `io.on('connection')` AFTER
 * the user joins their `user:<id>` room. NO `fetchSockets` on this path — the
 * reconnecting user is provably online (their socket just connected).
 *
 * Runs ONE set-based query for conversations holding a message authored by someone
 * ELSE that is newer than this user's `lastDeliveredAt` (or never delivered). For
 * each such conversation: advance THIS user's watermark to the latest such message's
 * `createdAt`, then emit ONE coalesced `message:delivered` per conversation to every
 * OTHER active participant's `user:<id>` room (the senders catching up). One event
 * per conversation, NOT one per message (D-04). `userId` in the payload is the
 * reconnecting recipient whose delivery advanced.
 *
 * Defensive: a failure for one conversation is logged and swallowed so it cannot
 * tear down the connection handler (the Task 3 caller also guards with `.catch`).
 */
export async function backfillDeliveryOnConnect(io: Server, userId: number): Promise<void> {
  const undelivered = await db
    .select({
      conversationId: conversationParticipants.conversationId,
      latest: sql<Date>`max(${messages.createdAt})`,
    })
    .from(conversationParticipants)
    .innerJoin(messages, eq(messages.conversationId, conversationParticipants.conversationId))
    .where(
      and(
        eq(conversationParticipants.userId, userId),
        isNull(conversationParticipants.leftAt),
        ne(messages.senderId, userId),
        or(
          isNull(conversationParticipants.lastDeliveredAt),
          gt(messages.createdAt, conversationParticipants.lastDeliveredAt),
        ),
      ),
    )
    .groupBy(conversationParticipants.conversationId);

  for (const row of undelivered) {
    try {
      const latest = row.latest instanceof Date ? row.latest : new Date(row.latest);

      // Advance THIS user's watermark to the latest undelivered message.
      await db
        .update(conversationParticipants)
        .set({ lastDeliveredAt: latest })
        .where(
          and(
            eq(conversationParticipants.conversationId, row.conversationId),
            eq(conversationParticipants.userId, userId),
          ),
        );

      // Fan ONE coalesced event per conversation to the OTHER active participants.
      const others = await db
        .select({ userId: conversationParticipants.userId })
        .from(conversationParticipants)
        .where(
          and(
            eq(conversationParticipants.conversationId, row.conversationId),
            isNull(conversationParticipants.leftAt),
            ne(conversationParticipants.userId, userId),
          ),
        );

      const deliveredUpTo = latest.toISOString();
      for (const o of others) {
        io.to(`user:${o.userId}`).emit('message:delivered', {
          conversationId: row.conversationId,
          userId,
          deliveredUpTo,
        } satisfies MessageDeliveredPayload);
      }
    } catch (err) {
      // Silent-failure socket convention — one bad conversation must not abort the loop.
      console.error('[receipts/backfill]', err);
    }
  }
}

/**
 * Read emit on every `lastReadAt`-advancing site (RCPT-06, RCPT-07, PRIV-02,
 * PRIV-04, RCPT-09). Single source of truth for the DM-vs-group decision and the
 * reciprocal privacy gate so they cannot drift across the four call sites
 * (chat per-conversation open, chat mark-all-read, notifications groups read-all,
 * notifications read-context cascade).
 *
 * Emits `message:read` to each OTHER active participant's `user:<id>` room (the
 * reader is excluded — Pitfall 1/3), NEVER to the conversation room (would leak
 * read state to non-authors — RCPT-09).
 *
 * - GROUP (`isGroup === true`): ALWAYS emits, regardless of any member's privacy
 *   flag (PRIV-04, WhatsApp group model). Emits to ALL other members so Phase 29
 *   can build per-member "Seen by N" (Open Question 1); payload `userId` = reader.
 * - DM (`isGroup` false OR null — nullable legacy 1:1, schema.ts:72): reciprocally
 *   gated via `bothAllowReadReceipts` (PRIV-02) — emits only when BOTH the reader
 *   and that partner have receipts ON.
 *
 * A deleted/missing conversation short-circuits (no row → return early). Callers
 * guard with `.catch` so this is not wrapped in try/catch here.
 */
export async function emitReadForConversation(
  io: Server,
  conversationId: number,
  readerId: number,
): Promise<void> {
  const [convo] = await db
    .select({ isGroup: conversations.isGroup })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!convo) return; // deleted/missing conversation → nothing to emit

  const isGroup = convo.isGroup === true; // null/false → DM (gated)

  const others = await db
    .select({ userId: conversationParticipants.userId })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        isNull(conversationParticipants.leftAt),
        ne(conversationParticipants.userId, readerId),
      ),
    );
  if (others.length === 0) return;

  const readUpTo = new Date().toISOString();
  for (const o of others) {
    // DM path: reciprocal gate (PRIV-02). Group path: always emit (PRIV-04).
    if (!isGroup && !(await bothAllowReadReceipts(readerId, o.userId))) continue;
    io.to(`user:${o.userId}`).emit('message:read', {
      conversationId,
      userId: readerId,
      readUpTo,
    } satisfies MessageReadPayload);
  }
}

/**
 * Thin bulk wrapper used by the two set-based read sites (mark-all-read and the
 * read-context cascade). Awaits `emitReadForConversation` per id so the single
 * DM-vs-group gate stays the only source of truth. Each id may be a DM or a group
 * — the per-conversation helper decides correctly.
 */
export async function emitReadForConversations(
  io: Server,
  conversationIds: number[],
  readerId: number,
): Promise<void> {
  for (const conversationId of conversationIds) {
    await emitReadForConversation(io, conversationId, readerId);
  }
}
