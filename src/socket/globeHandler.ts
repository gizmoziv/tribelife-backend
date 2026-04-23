import { Server, Socket } from 'socket.io';
import logger from '../lib/logger';
import { db } from '../db';
import { messages, userProfiles, notifications } from '../db/schema';
import { eq, inArray } from 'drizzle-orm';
import { checkRateLimit } from './rateLimit';
import { isValidGlobeRoom, AGE_GATE_HOURS } from '../config/globeRooms';
import { moderateMessage } from '../services/claude';
import { moderateMessageImages } from '../services/imageModeration';
import { sendPushToUser, shouldSendPush } from '../services/pushNotifications';

// ── Globe Room Event Handlers ───────────────────────────────────────────────
// Events: globe:join, globe:leave, globe:message, globe:typing

const log = logger.child({ module: 'socket:globe' });

export function registerGlobeHandlers(io: Server, socket: Socket): void {
  const userId: number = socket.data.userId;
  const handle: string = socket.data.handle;
  const createdAt: Date = socket.data.createdAt;
  const avatarUrl: string | null = socket.data.avatarUrl;

  // ── Join a Globe room ───────────────────────────────────────────────────
  socket.on('globe:join', (data: { slug: string }) => {
    if (!isValidGlobeRoom(data.slug)) return;

    // Leave any existing globe rooms first
    for (const room of socket.rooms) {
      if (room.startsWith('globe:')) {
        socket.leave(room);
      }
    }

    const roomId = 'globe:' + data.slug;
    socket.join(roomId);

    const count = io.sockets.adapter.rooms.get(roomId)?.size ?? 0;
    io.to(roomId).emit('globe:participants', { slug: data.slug, count });
  });

  // ── Leave a Globe room ──────────────────────────────────────────────────
  socket.on('globe:leave', (data: { slug: string }) => {
    const roomId = 'globe:' + data.slug;
    socket.leave(roomId);

    const count = io.sockets.adapter.rooms.get(roomId)?.size ?? 0;
    io.to(roomId).emit('globe:participants', { slug: data.slug, count });
  });

  // ── Send a message to a Globe room ──────────────────────────────────────
  socket.on('globe:message', async (data: { slug: string; content: string; replyToId?: number; mediaUrls?: string[] }) => {
    const content = data.content?.trim() ?? '';
    const mediaUrls = Array.isArray(data.mediaUrls)
      ? data.mediaUrls.filter((u): u is string => typeof u === 'string').slice(0, 4)
      : [];
    if (!content && mediaUrls.length === 0) return;
    if (content.length > 2000) return;
    if (!isValidGlobeRoom(data.slug)) return;

    // Age gate check — accounts less than 24 hours old cannot post
    const accountAge = Date.now() - createdAt.getTime();
    const ageGateMs = AGE_GATE_HOURS * 3600000;
    if (accountAge < ageGateMs) {
      socket.emit('globe:age_gated', {
        hoursRemaining: Math.ceil((ageGateMs - accountAge) / 3600000),
      });
      return;
    }

    // Rate limit check — 1 msg/sec per user per room
    const roomId = 'globe:' + data.slug;
    if (!checkRateLimit(userId, roomId)) {
      socket.emit('globe:rate_limited', { retryAfterMs: 1000 });
      return;
    }

    // Content moderation (skip for image-only messages)
    if (content) {
      const modResult = moderateMessage(content);
      if (!modResult.isAllowed) {
        socket.emit('message:rejected', { reason: modResult.reason });
        return;
      }
    }

    // Parse @mentions so we can store them on the message and notify targets
    const mentionedHandles = [...content.matchAll(/@([a-zA-Z0-9_]+)/g)].map(
      (m) => m[1].toLowerCase(),
    );
    let mentionedUserIds: number[] = [];
    if (mentionedHandles.length > 0) {
      const mentionedProfiles = await db
        .select({ userId: userProfiles.userId })
        .from(userProfiles)
        .where(inArray(userProfiles.handle, mentionedHandles));
      mentionedUserIds = mentionedProfiles.map((p) => p.userId);
    }

    // Persist message
    const [msg] = await db
      .insert(messages)
      .values({
        content,
        senderId: userId,
        roomId,
        mentions: mentionedUserIds,
        replyToId: data.replyToId ?? null,
        mediaUrls: mediaUrls.length > 0 ? mediaUrls : null,
      })
      .returning();

    // Build replyTo preview if this is a reply; capture original sender for notifications
    let replyTo: { id: number; content: string; senderHandle: string } | null = null;
    let replyToSenderId: number | null = null;
    if (data.replyToId) {
      const [original] = await db
        .select({
          id: messages.id,
          content: messages.content,
          senderHandle: userProfiles.handle,
          senderId: messages.senderId,
        })
        .from(messages)
        .leftJoin(userProfiles, eq(userProfiles.userId, messages.senderId))
        .where(eq(messages.id, data.replyToId))
        .limit(1);
      if (original) {
        replyTo = { id: original.id, content: original.content ?? '', senderHandle: original.senderHandle ?? 'Unknown' };
        replyToSenderId = original.senderId;
      }
    }

    // Broadcast to room
    io.to(roomId).emit('globe:message', {
      id: msg.id,
      content,
      senderId: userId,
      senderHandle: handle,
      senderAvatar: avatarUrl,
      roomId,
      slug: data.slug,
      createdAt: msg.createdAt,
      mentions: mentionedUserIds,
      replyToId: data.replyToId ?? null,
      replyTo,
      mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
    });

    // Fan-out a lightweight unread signal to everyone. Users who never joined
    // this globe room (e.g. still looking at the Beacons tab) would otherwise
    // never learn there's a new message, so their Globe tab badge would stay
    // stale until they opened the room. The 'globe-signals' room is joined by
    // every connected socket in index.ts.
    io.to('globe-signals').emit('globe:unread-signal', {
      slug: data.slug,
      roomId,
      senderId: userId,
    });

    // Build the full set of users to notify: explicit @mentions + reply target
    const notifyUserIds = new Set<number>(mentionedUserIds);
    if (replyToSenderId && replyToSenderId !== userId) {
      notifyUserIds.add(replyToSenderId);
    }
    const explicitMentions = new Set(mentionedUserIds);

    for (const notifyId of notifyUserIds) {
      if (notifyId === userId) continue;

      const isReplyTarget = notifyId === replyToSenderId && !explicitMentions.has(notifyId);
      const title = isReplyTarget ? `@${handle} replied to you` : `@${handle} mentioned you`;

      const [inserted] = await db.insert(notifications).values({
        userId: notifyId,
        type: 'mention',
        title,
        body: content.slice(0, 100),
        data: { messageId: msg.id, roomId, globeSlug: data.slug, senderHandle: handle },
      }).returning({ id: notifications.id });

      io.to(`user:${notifyId}`).emit('notification:new', {
        type: 'mention',
        title,
        body: content.slice(0, 100),
      });

      const [targetProfile] = await db
        .select({ expoPushToken: userProfiles.expoPushToken })
        .from(userProfiles)
        .where(eq(userProfiles.userId, notifyId))
        .limit(1);

      if (await shouldSendPush(notifyId, 'mention')) {
        await sendPushToUser(
          targetProfile?.expoPushToken,
          title,
          content.slice(0, 100),
          { type: 'mention', roomId, globeSlug: data.slug, notificationId: inserted.id },
          notifyId,
        );
      }
    }

    // Fire-and-forget image moderation
    if (mediaUrls.length > 0) {
      moderateMessageImages(msg.id, mediaUrls, userId, io, roomId)
        .catch(err => log.error({ err }, 'Globe image check failed'));
    }
  });

  // ── Typing indicator ────────────────────────────────────────────────────
  socket.on('globe:typing', (data: { slug: string; isTyping: boolean }) => {
    socket.to('globe:' + data.slug).emit('globe:typing', {
      slug: data.slug,
      handle,
      isTyping: data.isTyping,
    });
  });

  // ── Disconnect — update participant counts for Globe rooms ──────────────
  socket.on('disconnect', () => {
    for (const room of [...socket.rooms]) {
      if (room.startsWith('globe:')) {
        const slug = room.replace('globe:', '');
        setTimeout(() => {
          const count = io.sockets.adapter.rooms.get(room)?.size ?? 0;
          io.to(room).emit('globe:participants', { slug, count });
        }, 0);
      }
    }
  });
}
