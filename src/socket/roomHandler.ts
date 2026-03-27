import { Server, Socket } from 'socket.io';
import { db } from '../db';
import { messages, userProfiles, notifications } from '../db/schema';
import { eq } from 'drizzle-orm';
import { moderateMessage } from '../services/claude';
import { sendPushToUser } from '../services/pushNotifications';

export function registerRoomHandlers(io: Server, socket: Socket): void {
  const userId: number = socket.data.userId;
  const timezone: string = socket.data.timezone;
  const handle: string = socket.data.handle;

  // Auto-join the user's timezone room for location-based chat
  const timezoneRoom = `timezone:${timezone}`;
  socket.join(timezoneRoom);

  // ── Send a message to a timezone room ─────────────────────────────────
  socket.on('room:message', async (data: { content: string; replyToId?: number }) => {
    const content = data.content?.trim();
    if (!content || content.length > 2000) return;

    // Content moderation check
    const modResult = moderateMessage(content);
    if (!modResult.isAllowed) {
      socket.emit('message:rejected', { reason: modResult.reason });
      return;
    }

    // Parse @mentions
    const mentionedHandles = [...content.matchAll(/@([a-zA-Z0-9_]+)/g)].map(
      (m) => m[1].toLowerCase()
    );

    let mentionedUserIds: number[] = [];

    if (mentionedHandles.length > 0) {
      const mentionedProfiles = await db
        .select({ userId: userProfiles.userId, handle: userProfiles.handle })
        .from(userProfiles)
        .where(eq(userProfiles.handle, mentionedHandles[0]));  // simplified for now

      mentionedUserIds = mentionedProfiles.map((p) => p.userId);
    }

    // Persist message
    const [msg] = await db
      .insert(messages)
      .values({
        content,
        senderId: userId,
        roomId: timezoneRoom,
        mentions: mentionedUserIds,
        replyToId: data.replyToId ?? null,
      })
      .returning();

    // Broadcast to room
    const payload = {
      id: msg.id,
      content,
      senderId: userId,
      senderHandle: handle,
      roomId: timezoneRoom,
      createdAt: msg.createdAt,
      mentions: mentionedUserIds,
      replyToId: data.replyToId ?? null,
    };

    io.to(timezoneRoom).emit('room:message', payload);

    // Notify mentioned users
    for (const mentionedId of mentionedUserIds) {
      if (mentionedId === userId) continue;

      await db.insert(notifications).values({
        userId: mentionedId,
        type: 'mention',
        title: `@${handle} mentioned you`,
        body: content.slice(0, 100),
        data: { messageId: msg.id, roomId: timezoneRoom, senderHandle: handle },
      });

      // Emit real-time notification if user is online
      io.to(`user:${mentionedId}`).emit('notification:new', {
        type: 'mention',
        title: `@${handle} mentioned you`,
        body: content.slice(0, 100),
      });

      // Push notification if not in this room
      const mentionedProfile = await db
        .select({ expoPushToken: userProfiles.expoPushToken })
        .from(userProfiles)
        .where(eq(userProfiles.userId, mentionedId))
        .limit(1);

      await sendPushToUser(
        mentionedProfile[0]?.expoPushToken,
        `@${handle} mentioned you`,
        content.slice(0, 100),
        { type: 'mention', roomId: timezoneRoom }
      );
    }
  });
}
