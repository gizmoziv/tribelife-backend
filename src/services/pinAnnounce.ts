import { eq } from 'drizzle-orm';
import { db } from '../db';
import { messages, conversations } from '../db/schema';
import { getIO } from '../lib/socketRegistry';
import logger from '../lib/logger';

const log = logger.child({ module: 'pin-announce' });

/**
 * Payload broadcast on the live pin/unpin socket event to everyone in the room.
 * `pin` is null when action='unpin' (the bar is cleared).
 */
export interface PinEventPayload {
  action: 'pin' | 'unpin';
  roomId?: string;
  conversationId?: number;
  slug?: string;
  pin: {
    id: number;
    messageId: number;
    pinnedAt: string;
    previewText: string | null;
    pinnedMediaUrl: string | null;
    pinnedSenderHandle: string | null;
  } | null;
}

/**
 * Posts a kind='system' "{handle} pinned/unpinned a message" line into the
 * target room or conversation, bumps conversations.lastMessageAt for DM/group
 * surfaces so the pin system line floats the Chats list to top, and broadcasts
 * both the system message and the pin event on the correct socket channel.
 *
 * LANDMINE: globe rooms must emit to `globe-feed:<slug>` — NEVER `globe:<slug>`.
 */
export async function announcePinAction(args: {
  roomId?: string;
  conversationId?: number;
  userId: number;
  handle: string;
  action: 'pin' | 'unpin';
  pinPayload: PinEventPayload;
}): Promise<void> {
  const { roomId, conversationId, userId, handle, action, pinPayload } = args;
  const lower = (handle ?? '').toLowerCase();
  const content = action === 'pin'
    ? `@${lower} pinned a message`
    : `@${lower} unpinned a message`;
  const io = getIO();

  if (roomId) {
    try {
      const [sysMsg] = await db
        .insert(messages)
        .values({ content, senderId: userId, roomId, kind: 'system', mentions: [userId] })
        .returning();

      if (io) {
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

        // LANDMINE 1+2: globe rooms emit to globe-feed:<slug>, NOT globe:<slug>
        if (roomId.startsWith('globe:')) {
          const slug = roomId.slice('globe:'.length);
          io.to('globe-feed:' + slug).emit('globe:message', { ...base, roomId, slug });
          // Emit pin event to the same globe-feed channel
          io.to('globe-feed:' + slug).emit('globe:pinned', { ...pinPayload, slug });
        } else if (roomId.startsWith('timezone:')) {
          const slug = roomId.slice('timezone:'.length);
          io.to(roomId).emit('room:message', { ...base, roomId });
          io.to('globe-feed:' + slug).emit('globe:message', { ...base, roomId, slug });
          // Emit pin event to the timezone room
          io.to(roomId).emit('room:pinned', pinPayload);
        }
      }
    } catch (err) {
      log.error({ err, roomId, userId }, 'pin-announce: room post failed');
    }
  } else if (conversationId) {
    try {
      const [sysMsg] = await db
        .insert(messages)
        .values({ content, senderId: userId, conversationId, kind: 'system', mentions: [userId] })
        .returning();

      // Pitfall 5: bump lastMessageAt so the pin system line floats the Chats list to top
      await db
        .update(conversations)
        .set({ lastMessageAt: new Date() })
        .where(eq(conversations.id, conversationId));

      if (io) {
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
        // Emit pin event to the conversation room
        io.to('conversation:' + conversationId).emit('dm:pinned', pinPayload);
      }
    } catch (err) {
      log.error({ err, conversationId, userId }, 'pin-announce: conversation post failed');
    }
  }

  log.info({ userId, roomId, conversationId, action }, 'pin-announce posted');
}
