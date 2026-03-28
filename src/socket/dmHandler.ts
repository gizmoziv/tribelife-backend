import { Server, Socket } from 'socket.io';
import { db } from '../db';
import {
  messages,
  conversations,
  conversationParticipants,
  userProfiles,
  notifications,
  blockedUsers,
} from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { moderateMessage } from '../services/claude';
import { sendPushToUser } from '../services/pushNotifications';

export function registerDmHandlers(io: Server, socket: Socket): void {
  const userId: number = socket.data.userId;
  const handle: string = socket.data.handle;

  // ── Send a direct message ─────────────────────────────────────────────
  socket.on('dm:message', async (data: { conversationId: number; content: string; replyToId?: number }) => {
    const content = data.content?.trim();
    if (!content || content.length > 2000) return;

    // Content moderation check
    const dmModResult = moderateMessage(content);
    if (!dmModResult.isAllowed) {
      socket.emit('message:rejected', { reason: dmModResult.reason });
      return;
    }

    // Verify participant
    const participation = await db
      .select()
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, data.conversationId),
          eq(conversationParticipants.userId, userId)
        )
      )
      .limit(1);

    if (participation.length === 0) return;

    // Block check — reject if any other participant in the conversation has blocked the sender
    const allParticipants = await db
      .select({ userId: conversationParticipants.userId })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.conversationId, data.conversationId));

    const otherParticipantIds = allParticipants
      .map((p) => p.userId)
      .filter((id) => id !== userId);

    for (const otherId of otherParticipantIds) {
      const block = await db
        .select({ id: blockedUsers.id })
        .from(blockedUsers)
        .where(
          and(
            eq(blockedUsers.userId, otherId),
            eq(blockedUsers.blockedUserId, userId)
          )
        )
        .limit(1);

      if (block.length > 0) {
        socket.emit('message:rejected', { reason: 'You cannot message this user' });
        return;
      }
    }

    // Save message
    const [msg] = await db
      .insert(messages)
      .values({
        content,
        senderId: userId,
        conversationId: data.conversationId,
        replyToId: data.replyToId ?? null,
      })
      .returning();

    // Update conversation timestamp
    await db
      .update(conversations)
      .set({ lastMessageAt: new Date() })
      .where(eq(conversations.id, data.conversationId));

    // Clear hiddenAt for all participants so hidden conversations reappear
    await db
      .update(conversationParticipants)
      .set({ hiddenAt: null })
      .where(eq(conversationParticipants.conversationId, data.conversationId));

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

    const msgPayload = {
      id: msg.id,
      content,
      senderId: userId,
      senderHandle: handle,
      conversationId: data.conversationId,
      createdAt: msg.createdAt,
      replyToId: data.replyToId ?? null,
      replyTo,
    };

    // Emit to conversation room
    io.to(`conversation:${data.conversationId}`).emit('dm:message', msgPayload);

    // Notify the other participant
    const otherParticipants = await db
      .select({ userId: conversationParticipants.userId })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.conversationId, data.conversationId));

    for (const p of otherParticipants) {
      if (p.userId === userId) continue;

      await db.insert(notifications).values({
        userId: p.userId,
        type: 'new_dm',
        title: `Message from @${handle}`,
        body: content.slice(0, 100),
        data: { conversationId: data.conversationId, senderHandle: handle },
      });

      io.to(`user:${p.userId}`).emit('notification:new', {
        type: 'new_dm',
        title: `Message from @${handle}`,
        body: content.slice(0, 100),
        conversationId: data.conversationId,
      });

      const otherProfile = await db
        .select({ expoPushToken: userProfiles.expoPushToken })
        .from(userProfiles)
        .where(eq(userProfiles.userId, p.userId))
        .limit(1);

      await sendPushToUser(
        otherProfile[0]?.expoPushToken,
        `Message from @${handle}`,
        content.slice(0, 100),
        { type: 'new_dm', conversationId: data.conversationId }
      );
    }
  });

  // ── Join a DM conversation room ───────────────────────────────────────
  socket.on('dm:join', (data: { conversationId: number }) => {
    socket.join(`conversation:${data.conversationId}`);
  });

  // ── Leave a DM conversation room ──────────────────────────────────────
  socket.on('dm:leave', (data: { conversationId: number }) => {
    socket.leave(`conversation:${data.conversationId}`);
  });
}
