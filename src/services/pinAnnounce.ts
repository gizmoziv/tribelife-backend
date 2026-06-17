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
 * Client-shaped system message returned by `announcePinAction` so the actor's
 * own client can append the "{handle} pinned/unpinned a message" line locally
 * (deduped by id against the socket echo). Mirrors exactly what is emitted over
 * the socket. `roomId`/`slug` are set for the room branch; `conversationId` for
 * the conversation branch.
 */
export interface PinSystemMessage {
  id: number;
  content: string;
  senderId: number;
  senderHandle: string;
  senderAvatar: null;
  createdAt: Date | null;
  kind: 'system';
  mentions: number[];
  replyToId: null;
  replyTo: null;
  roomId?: string;
  slug?: string;
  conversationId?: number;
}

/**
 * Posts a kind='system' "{handle} pinned/unpinned a message" line into the
 * target room or conversation, bumps conversations.lastMessageAt for DM/group
 * surfaces so the pin system line floats the Chats list to top, and broadcasts
 * both the system message and the pin event on the correct socket channel.
 *
 * Returns the client-shaped system message (the same shape it emits over the
 * socket) so the actor's client can append it immediately and dedup-by-id
 * against the socket echo; returns null when no system message was created
 * (e.g. neither roomId nor conversationId, or the insert/io path is skipped).
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
}): Promise<PinSystemMessage | null> {
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

      const base = {
        id: sysMsg.id,
        content,
        senderId: userId,
        senderHandle: lower,
        senderAvatar: null as null,
        createdAt: sysMsg.createdAt,
        kind: 'system' as const,
        mentions: [userId],
        replyToId: null as null,
        replyTo: null as null,
      };

      // Derive the globe slug for the returned/emitted payload. Globe rooms
      // carry their slug; timezone rooms mirror their feed onto a globe slug too.
      let slug: string | undefined;
      if (roomId.startsWith('globe:')) {
        slug = roomId.slice('globe:'.length);
      } else if (roomId.startsWith('timezone:')) {
        slug = roomId.slice('timezone:'.length);
      }

      if (io) {
        // LANDMINE 1+2: globe rooms emit to globe-feed:<slug>, NOT globe:<slug>
        if (roomId.startsWith('globe:')) {
          io.to('globe-feed:' + slug).emit('globe:message', { ...base, roomId, slug });
          // Emit pin event to the same globe-feed channel
          io.to('globe-feed:' + slug).emit('globe:pinned', { ...pinPayload, slug });
        } else if (roomId.startsWith('timezone:')) {
          io.to(roomId).emit('room:message', { ...base, roomId });
          io.to('globe-feed:' + slug).emit('globe:message', { ...base, roomId, slug });
          // Emit pin event to the timezone room (Local Chat viewers)
          io.to(roomId).emit('room:pinned', pinPayload);
          // CR-02: ALSO notify Globe viewers of the same zone — they subscribe
          // to globe:pinned on globe-feed:<slug>, not room:pinned on the
          // timezone room. Without this their PinnedBar never updates/clears
          // until they leave and re-enter the screen.
          io.to('globe-feed:' + slug).emit('globe:pinned', { ...pinPayload, slug });
        }
      }

      log.info({ userId, roomId, conversationId, action }, 'pin-announce posted');
      return { ...base, roomId, ...(slug != null ? { slug } : {}) };
    } catch (err) {
      log.error({ err, roomId, userId }, 'pin-announce: room post failed');
      return null;
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

      const base = {
        id: sysMsg.id,
        content,
        senderId: userId,
        senderHandle: lower,
        senderAvatar: null as null,
        createdAt: sysMsg.createdAt,
        kind: 'system' as const,
        mentions: [userId],
        replyToId: null as null,
        replyTo: null as null,
      };

      if (io) {
        io.to('conversation:' + conversationId).emit('dm:message', { ...base, conversationId });
        // Emit pin event to the conversation room
        io.to('conversation:' + conversationId).emit('dm:pinned', pinPayload);
      }

      log.info({ userId, roomId, conversationId, action }, 'pin-announce posted');
      return { ...base, conversationId };
    } catch (err) {
      log.error({ err, conversationId, userId }, 'pin-announce: conversation post failed');
      return null;
    }
  }

  log.info({ userId, roomId, conversationId, action }, 'pin-announce posted (no-op)');
  return null;
}
