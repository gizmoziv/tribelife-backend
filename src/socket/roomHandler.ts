import { Server, Socket } from 'socket.io';
import logger from '../lib/logger';
import { db } from '../db';

const log = logger.child({ module: 'socket:room' });
import { messages, userProfiles, notifications, notificationPreferences, blockedUsers } from '../db/schema';
import { and, eq, inArray, ne, isNotNull, or } from 'drizzle-orm';
import { moderateMessage } from '../services/claude';
import { moderateMessageImages } from '../services/imageModeration';
import { sendPushToUser, sendPushNotifications, shouldSendPush, getUnreadBadgeCounts } from '../services/pushNotifications';

export function registerRoomHandlers(io: Server, socket: Socket): void {
  const userId: number = socket.data.userId;
  const timezone: string = socket.data.timezone;
  const handle: string = socket.data.handle;

  // Auto-join the user's timezone room for location-based chat
  const timezoneRoom = `timezone:${timezone}`;
  socket.join(timezoneRoom);

  // ── Send a message to a timezone room ─────────────────────────────────
  socket.on('room:message', async (data: { content: string; replyToId?: number; mediaUrls?: string[] }) => {
    const content = data.content?.trim() ?? '';
    const mediaUrls = Array.isArray(data.mediaUrls)
      ? data.mediaUrls.filter((u): u is string => typeof u === 'string').slice(0, 4)
      : [];
    if (!content && mediaUrls.length === 0) return;
    if (content.length > 2000) return;

    // Content moderation check (skip for image-only messages)
    if (content) {
      const modResult = moderateMessage(content);
      if (!modResult.isAllowed) {
        socket.emit('message:rejected', { reason: modResult.reason });
        return;
      }
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
        .where(inArray(userProfiles.handle, mentionedHandles));

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
        mediaUrls: mediaUrls.length > 0 ? mediaUrls : null,
      })
      .returning();

    // Build replyTo preview if this is a reply, and capture the original sender
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
    const payload = {
      id: msg.id,
      content,
      senderId: userId,
      senderHandle: handle,
      roomId: timezoneRoom,
      createdAt: msg.createdAt,
      mentions: mentionedUserIds,
      replyToId: data.replyToId ?? null,
      replyTo,
      mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
    };

    io.to(timezoneRoom).emit('room:message', payload);

    // Fire-and-forget image moderation
    if (mediaUrls.length > 0) {
      moderateMessageImages(msg.id, mediaUrls, userId, io, timezoneRoom)
        .catch(err => log.error({ err }, 'Room image check failed'));
    }

    // Build the full set of users to notify: explicit @mentions + the reply target
    const notifyUserIds = new Set<number>(mentionedUserIds);
    if (replyToSenderId && replyToSenderId !== userId) {
      notifyUserIds.add(replyToSenderId);
    }
    const explicitMentions = new Set(mentionedUserIds);

    // Notify each user — title differs for reply vs mention
    for (const notifyId of notifyUserIds) {
      if (notifyId === userId) continue;

      const isReplyTarget = notifyId === replyToSenderId && !explicitMentions.has(notifyId);
      const title = isReplyTarget ? `@${handle} replied to you` : `@${handle} mentioned you`;

      await db.insert(notifications).values({
        userId: notifyId,
        type: 'mention',
        title,
        body: content.slice(0, 100),
        data: { messageId: msg.id, roomId: timezoneRoom, senderHandle: handle },
      });

      // Emit real-time notification if user is online
      io.to(`user:${notifyId}`).emit('notification:new', {
        type: 'mention',
        title,
        body: content.slice(0, 100),
      });

      // Push notification (respects mentions preference)
      const mentionedProfile = await db
        .select({ expoPushToken: userProfiles.expoPushToken })
        .from(userProfiles)
        .where(eq(userProfiles.userId, notifyId))
        .limit(1);

      if (await shouldSendPush(notifyId, 'mention')) {
        await sendPushToUser(
          mentionedProfile[0]?.expoPushToken,
          title,
          content.slice(0, 100),
          { type: 'mention', roomId: timezoneRoom },
          notifyId,
        );
      }
    }

    // ── Timezone chat push notifications ──────────────────────────────────
    // Send to other users in the same timezone who have timezoneChatPush
    // enabled. Skip sender, mentioned users (already notified), and blocked
    // pairs. Fire-and-forget — does not block the message broadcast.
    (async () => {
      try {
        // Find all users in this timezone with a push token (excluding sender)
        const candidates = await db
          .select({
            userId: userProfiles.userId,
            expoPushToken: userProfiles.expoPushToken,
          })
          .from(userProfiles)
          .where(
            and(
              eq(userProfiles.timezone, timezone),
              ne(userProfiles.userId, userId),
              isNotNull(userProfiles.expoPushToken),
            ),
          );

        if (candidates.length === 0) return;

        const candidateIds = candidates.map((c) => c.userId);

        // Fetch preferences for all candidates in one query
        const prefs = await db
          .select({
            userId: notificationPreferences.userId,
            timezoneChatPush: notificationPreferences.timezoneChatPush,
          })
          .from(notificationPreferences)
          .where(inArray(notificationPreferences.userId, candidateIds));

        const prefMap = new Map(prefs.map((p) => [p.userId, p.timezoneChatPush]));

        // Fetch block relationships (either direction)
        const blocks = await db
          .select({
            userId: blockedUsers.userId,
            blockedUserId: blockedUsers.blockedUserId,
          })
          .from(blockedUsers)
          .where(
            or(
              and(eq(blockedUsers.userId, userId), inArray(blockedUsers.blockedUserId, candidateIds)),
              and(eq(blockedUsers.blockedUserId, userId), inArray(blockedUsers.userId, candidateIds)),
            ),
          );

        const blockedSet = new Set<number>();
        for (const b of blocks) {
          blockedSet.add(b.userId === userId ? b.blockedUserId : b.userId);
        }

        // Skip both @mentions AND reply targets — they already got a mention push
        const alreadyNotified = notifyUserIds;

        const eligible = candidates.filter((c) => {
          if (blockedSet.has(c.userId)) return false;
          if (alreadyNotified.has(c.userId)) return false; // already got mention push
          const allowed = prefMap.has(c.userId) ? prefMap.get(c.userId) : true;
          return allowed && !!c.expoPushToken;
        });

        // Fetch unread badge counts for all eligible users in a single query
        const badgeMap = await getUnreadBadgeCounts(eligible.map((c) => c.userId));

        const pushBatch = eligible.map((c) => ({
          to: c.expoPushToken as string,
          title: `@${handle}`,
          body: content.slice(0, 100),
          data: { type: 'timezone_chat', roomId: timezoneRoom },
          sound: 'default' as const,
          badge: badgeMap.get(c.userId) ?? 0,
          channelId: 'default',
        }));

        if (pushBatch.length > 0) {
          await sendPushNotifications(pushBatch);
        }
      } catch (err) {
        log.error({ err }, 'Timezone chat push delivery failed');
      }
    })();
  });
}
