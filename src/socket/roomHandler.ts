import { Server, Socket } from 'socket.io';
import logger from '../lib/logger';
import { db } from '../db';

const log = logger.child({ module: 'socket:room' });
import { messages, userProfiles, notifications, notificationPreferences, blockedUsers } from '../db/schema';
import { and, eq, inArray, ne, isNotNull, or } from 'drizzle-orm';
import { moderateMessage } from '../services/claude';
import { moderateMessageImages } from '../services/imageModeration';
import { sendPushToUser, sendPushNotifications, shouldSendPush, getUnreadBadgeCounts } from '../services/pushNotifications';
import type { ChatNotificationPayload } from '../types/chatNotification';

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
      kind: 'user' as const,
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

      const [inserted] = await db.insert(notifications).values({
        userId: notifyId,
        type: 'mention',
        title,
        body: content.slice(0, 100),
        data: {
          messageId: msg.id,
          roomId: timezoneRoom,
          senderHandle: handle,
          // Phase 10 D-01 additive (10-CONTEXT.md): source discriminator + entityId
          // for /api/chats row identity.
          source: 'local_chat' as const,
          entityId: timezone,
          timezoneIana: timezone,
        },
      }).returning({ id: notifications.id });

      // Phase 10 D-03: chat-type notifications fan to `chat:notification`.
      // Bell-summary refresh happens via the mobile chat:notification listener
      // (Plan 10-03), which triggers `notificationsApi.summary()` so the bell's
      // mention count keeps updating without a separate notification:new emit.
      io.to(`user:${notifyId}`).emit('chat:notification', {
        source: 'local_chat',
        entityId: timezone,
        timezoneIana: timezone,
        notificationId: inserted.id,
        messageId: msg.id, // Phase 14 D-04
        title,
        body: content.slice(0, 100),
        senderHandle: handle,
      } satisfies ChatNotificationPayload);

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
          {
            type: 'chat',
            source: 'local_chat',
            entityId: timezone,
            timezoneIana: timezone,
            notificationId: inserted.id,
            messageId: msg.id, // Phase 14 D-04
            senderHandle: handle,
          },
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

        // ── Phase 10 D-02: insert notifications rows for every eligible Local
        // Chat recipient. Today this block was push-only; the row insert closes
        // the gap so the Chats-tab unread badge has a server source of truth.
        // The `type` column stays 'mention' (D-01 — no migration). The `data`
        // JSON carries `source: 'local_chat'` so the mobile tap-router can
        // deep-link to Local Chat.
        const notifIdByUser = new Map<number, number>();
        if (eligible.length > 0) {
          const insertedRows = await db.insert(notifications).values(
            eligible.map((c) => ({
              userId: c.userId,
              type: 'mention' as const,
              title: `@${handle}`,
              body: content.slice(0, 100),
              data: {
                messageId: msg.id,
                roomId: timezoneRoom,
                senderHandle: handle,
                source: 'local_chat' as const,
                entityId: timezone,
                timezoneIana: timezone,
              },
            })),
          ).returning({ id: notifications.id, userId: notifications.userId });
          for (const row of insertedRows) notifIdByUser.set(row.userId, row.id);
        }

        // Phase 10 D-03: emit chat:notification per eligible recipient.
        for (const c of eligible) {
          const notifId = notifIdByUser.get(c.userId);
          if (notifId === undefined) continue;
          io.to(`user:${c.userId}`).emit('chat:notification', {
            source: 'local_chat',
            entityId: timezone,
            timezoneIana: timezone,
            notificationId: notifId,
            messageId: msg.id, // Phase 14 D-04
            title: `@${handle}`,
            body: content.slice(0, 100),
            senderHandle: handle,
          } satisfies ChatNotificationPayload);
        }

        // Phase 10 D-04: push payload mirrors the socket payload exactly.
        const pushBatch = eligible.map((c) => ({
          to: c.expoPushToken as string,
          title: `@${handle}`,
          body: content.slice(0, 100),
          data: {
            type: 'chat' as const,
            source: 'local_chat' as const,
            entityId: timezone,
            timezoneIana: timezone,
            notificationId: notifIdByUser.get(c.userId)!,
            messageId: msg.id, // Phase 14 D-04
            senderHandle: handle,
          },
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
