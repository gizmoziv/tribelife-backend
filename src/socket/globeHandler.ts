import { Server, Socket } from 'socket.io';
import { db } from '../db';
import { messages, userProfiles } from '../db/schema';
import { eq } from 'drizzle-orm';
import { checkRateLimit } from './rateLimit';
import { isValidGlobeRoom, AGE_GATE_HOURS } from '../config/globeRooms';
import { moderateMessage } from '../services/claude';

// ── Globe Room Event Handlers ───────────────────────────────────────────────
// Events: globe:join, globe:leave, globe:message, globe:typing

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
  socket.on('globe:message', async (data: { slug: string; content: string; replyToId?: number }) => {
    const content = data.content?.trim();
    if (!content || content.length > 2000) return;
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

    // Content moderation
    const modResult = moderateMessage(content);
    if (!modResult.isAllowed) {
      socket.emit('message:rejected', { reason: modResult.reason });
      return;
    }

    // Persist message
    const [msg] = await db
      .insert(messages)
      .values({
        content,
        senderId: userId,
        roomId,
        replyToId: data.replyToId ?? null,
      })
      .returning();

    // Build replyTo preview if this is a reply
    let replyTo: { id: number; content: string; senderHandle: string } | null = null;
    if (data.replyToId) {
      const [original] = await db
        .select({ id: messages.id, content: messages.content, senderHandle: userProfiles.handle })
        .from(messages)
        .leftJoin(userProfiles, eq(userProfiles.userId, messages.senderId))
        .where(eq(messages.id, data.replyToId))
        .limit(1);
      if (original) {
        replyTo = { id: original.id, content: original.content ?? '', senderHandle: original.senderHandle ?? 'Unknown' };
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
      replyToId: data.replyToId ?? null,
      replyTo,
    });
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
