import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { messages, conversations } from '../db/schema';
import { getIO } from '../lib/socketRegistry';
import logger from '../lib/logger';

const log = logger.child({ module: 'moderation-announce' });

/**
 * Posts a centered "@handle was blocked by our system" system message into every
 * room and conversation the user has posted in, and broadcasts it live.
 *
 * The row is persisted with kind='system' (senderId = the blocked user, so the
 * history leftJoin hydrates handle/avatar, mirroring the join-announcement
 * pattern in routes/auth.ts), so it also shows up in scrollback on next open even
 * for users who weren't connected at the moment of the ban.
 *
 * Live delivery mirrors the existing per-channel emit shapes exactly:
 *   - timezone:<zone>  → room:message  @ timezone:<zone>     (native Local Chat)
 *                      + globe:message @ globe-feed:<zone>    (GlobeRoomScreen mirror)
 *   - globe:<slug>     → globe:message @ globe-feed:<slug>
 *   - conversation     → dm:message    @ conversation:<id>
 *
 * Best-effort: a failure on one room/conversation is logged and skipped — the ban
 * itself is never blocked by an announcement error.
 */
export async function announceUserBlocked(
  userId: number,
  handle: string,
): Promise<{ rooms: number; conversations: number }> {
  const lower = (handle ?? '').toLowerCase();
  const content = `@${lower} was blocked by our system`;
  const io = getIO();

  // Footprint: every distinct room + conversation the user ever posted in.
  const roomRows = await db
    .selectDistinct({ roomId: messages.roomId })
    .from(messages)
    .where(and(eq(messages.senderId, userId), isNotNull(messages.roomId)));

  const convRows = await db
    .selectDistinct({ conversationId: messages.conversationId })
    .from(messages)
    .where(and(eq(messages.senderId, userId), isNotNull(messages.conversationId)));

  for (const { roomId } of roomRows) {
    if (!roomId) continue;
    try {
      const [sysMsg] = await db
        .insert(messages)
        .values({ content, senderId: userId, roomId, kind: 'system', mentions: [userId] })
        .returning();

      if (!io) continue;
      const base = {
        id: sysMsg.id,
        content,
        senderId: userId,
        senderHandle: lower,
        senderAvatar: null,
        createdAt: sysMsg.createdAt,
        kind: 'system' as const,
        mentions: [userId],
        replyToId: null,
        replyTo: null,
      };

      if (roomId.startsWith('globe:')) {
        const slug = roomId.slice('globe:'.length);
        io.to('globe-feed:' + slug).emit('globe:message', { ...base, roomId, slug });
      } else if (roomId.startsWith('timezone:')) {
        const slug = roomId.slice('timezone:'.length);
        io.to(roomId).emit('room:message', { ...base, roomId });
        io.to('globe-feed:' + slug).emit('globe:message', { ...base, roomId, slug });
      }
    } catch (err) {
      log.error({ err, roomId, userId }, 'blocked-announce: room post failed');
    }
  }

  for (const { conversationId } of convRows) {
    if (!conversationId) continue;
    try {
      const [sysMsg] = await db
        .insert(messages)
        .values({ content, senderId: userId, conversationId, kind: 'system', mentions: [userId] })
        .returning();

      // Bump lastMessageAt so the notice orders correctly in the Chats list.
      await db
        .update(conversations)
        .set({ lastMessageAt: new Date() })
        .where(eq(conversations.id, conversationId));

      if (!io) continue;
      io.to('conversation:' + conversationId).emit('dm:message', {
        id: sysMsg.id,
        content,
        senderId: userId,
        senderHandle: lower,
        senderAvatar: null,
        conversationId,
        createdAt: sysMsg.createdAt,
        kind: 'system',
        mentions: [userId],
        replyToId: null,
        replyTo: null,
      });
    } catch (err) {
      log.error({ err, conversationId, userId }, 'blocked-announce: conversation post failed');
    }
  }

  log.info({ userId, rooms: roomRows.length, conversations: convRows.length }, 'user-blocked announcement posted');
  return { rooms: roomRows.length, conversations: convRows.length };
}
