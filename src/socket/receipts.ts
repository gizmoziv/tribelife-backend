import { Server } from 'socket.io';
import { db } from '../db';
import { notificationPreferences } from '../db/schema';
import { inArray } from 'drizzle-orm';

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
