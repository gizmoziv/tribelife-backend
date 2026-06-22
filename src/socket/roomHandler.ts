import { Server, Socket } from 'socket.io';
import logger from '../lib/logger';
import { db } from '../db';

const log = logger.child({ module: 'socket:room' });
import { messages, userProfiles, notifications } from '../db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { moderateMessage } from '../services/claude';
import { moderateMessageImages } from '../services/imageModeration';
import { sendPushNotifications, shouldSendPush, getUnreadBadgeCounts } from '../services/pushNotifications';
import { isUserActivelyViewing, canonicalViewingKey } from './activeViewing';
import type { ChatNotificationPayload } from '../types/chatNotification';
import { getZoneForTimezone, getZoneMemberIds } from '../config/timezoneZones';

export function registerRoomHandlers(io: Server, socket: Socket): void {
  const userId: number = socket.data.userId;
  const timezone: string = socket.data.timezone;
  const handle: string = socket.data.handle;

  // Phase 15 D-01 (RESEARCH §I3): derive the canonical zone slug ONCE from the
  // user's IANA timezone, then reuse it for the auto-join room key, every
  // `room:message` persistence, and every broadcast emit. Notification payload
  // fields `entityId` + `timezoneIana` STAY raw IANA (RESEARCH §I5 + Phase 10
  // D-01 — those are mobile routing hints, not room keys).
  const zoneSlug = getZoneForTimezone(timezone);

  // Auto-join the user's timezone room for location-based chat
  const timezoneRoom = `timezone:${zoneSlug}`;
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
        .select({ userId: userProfiles.userId, handle: userProfiles.handle, timezone: userProfiles.timezone })
        .from(userProfiles)
        .where(inArray(userProfiles.handle, mentionedHandles));

      // NOTIF-03: a timezone room's membership is the set of users whose profile
      // timezone maps to the same zoneSlug. Filter out mentions of users in other
      // zones — they cannot see this Local Chat and must not be notified.
      mentionedUserIds = mentionedProfiles
        .filter((p) => getZoneForTimezone(p.timezone ?? 'UTC') === zoneSlug)
        .map((p) => p.userId);
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

    // Build the full set of directed targets: explicit @mentions + the reply target
    const directedTargets = new Set<number>(mentionedUserIds);
    if (replyToSenderId && replyToSenderId !== userId) {
      directedTargets.add(replyToSenderId);
    }
    const explicitMentions = new Set(mentionedUserIds);

    // ── Mention / reply notifications (directed targets only) ─────────────
    // Each directed target gets a stored type:'mention' row (DMs tab) + push.
    // M5: they do NOT also get a type:'group' row — that would double-notify.
    // 260621-un7: canonical viewing key for this timezone surface. Mobile
    // normalizes timezone/local to `globe:<slug>`, so collapse the
    // `timezone:<slug>` roomId here to match exactly.
    const viewingRoomKey = canonicalViewingKey(timezoneRoom);

    for (const notifyId of directedTargets) {
      if (notifyId === userId) continue;
      // 260621-un7: skip emit + row + push if actively viewing this zone.
      if (await isUserActivelyViewing(io, notifyId, viewingRoomKey)) continue;

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
          timezoneZone: zoneSlug,
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
        timezoneZone: zoneSlug,
        notificationId: inserted.id,
        messageId: msg.id, // Phase 14 D-04
        title,
        body: content.slice(0, 100),
        senderHandle: handle,
      } satisfies ChatNotificationPayload);

      // Push notification (respects mentions preference)
      const [mentionedProfile] = await db
        .select({ expoPushToken: userProfiles.expoPushToken })
        .from(userProfiles)
        .where(eq(userProfiles.userId, notifyId))
        .limit(1);

      if (await shouldSendPush(notifyId, 'mention')) {
        const token = mentionedProfile?.expoPushToken;
        if (token?.startsWith('ExponentPushToken[')) {
          await sendPushNotifications([{
            to: token,
            title,
            body: content.slice(0, 100),
            data: {
              type: 'chat',
              source: 'local_chat',
              entityId: timezone,
              timezoneIana: timezone,
              timezoneZone: zoneSlug,
              notificationId: inserted.id,
              messageId: msg.id, // Phase 14 D-04
              senderHandle: handle,
            },
            sound: 'default',
          }]);
        }
      }
    }

    // ── Plain-message group fan-out (D-13/D-14) ───────────────────────────
    // Runs AFTER the live broadcast (post-broadcast deferral for chat latency,
    // M6). All zone members EXCEPT sender (D-17) and directed targets (M5)
    // get a stored type:'group' row + groupsPush-gated push.
    // D-16: this handler only processes user sends (REST routes handle system
    // messages and do NOT pass through here, so no group rows are created for
    // join/system events — the silence is structural, not guarded).
    setImmediate(async () => {
      try {
        // Fetch all zone members (sender already excluded via helper param).
        const zoneMembers = await getZoneMemberIds(zoneSlug, userId);
        if (zoneMembers.length === 0) return;

        // M5: exclude directed targets — they already got a mention row.
        const groupCandidates = zoneMembers.filter((id) => !directedTargets.has(id));
        if (groupCandidates.length === 0) return;

        // 260621-un7: drop members actively viewing this zone so no row is
        // inserted and no emit/push fires (all 3 channels skipped together).
        const groupRecipients: number[] = [];
        for (const rid of groupCandidates) {
          if (await isUserActivelyViewing(io, rid, viewingRoomKey)) continue;
          groupRecipients.push(rid);
        }
        if (groupRecipients.length === 0) return;

        // Batched token + push-pref fetch in ONE query (M6 — no N selects).
        const profileRows = await db
          .select({ userId: userProfiles.userId, expoPushToken: userProfiles.expoPushToken })
          .from(userProfiles)
          .where(inArray(userProfiles.userId, groupRecipients));
        const tokenMap = new Map<number, string | null>(
          profileRows.map((r) => [r.userId, r.expoPushToken ?? null]),
        );

        // Batch-check groupsPush preferences (reuses shouldSendPush per user,
        // but the prefs fetch is already O(1) per user via the DB — acceptable
        // since this is deferred via setImmediate).
        const notifBody = content.slice(0, 100);
        const groupTitle = `@${handle}`;

        // MANDATORY batched notification INSERT (single multi-row insert, M6).
        const insertValues = groupRecipients.map((recipientId) => ({
          userId: recipientId,
          type: 'group' as const,
          title: groupTitle,
          body: notifBody,
          data: {
            messageId: msg.id,
            roomId: timezoneRoom,
            senderHandle: handle,
            source: 'local_chat' as const,
            entityId: timezone,
            timezoneIana: timezone,
            timezoneZone: zoneSlug,
          },
        }));

        const insertedRows = await db
          .insert(notifications)
          .values(insertValues)
          .returning({ id: notifications.id, userId: notifications.userId });

        // Map userId → notificationId for the socket emit.
        const notifIdMap = new Map<number, number>(
          insertedRows.map((r) => [r.userId, r.id]),
        );

        // Emit chat:notification to each recipient's personal room.
        for (const recipientId of groupRecipients) {
          const notifId = notifIdMap.get(recipientId);
          if (notifId === undefined) continue;
          io.to(`user:${recipientId}`).emit('chat:notification', {
            source: 'local_chat',
            entityId: timezone,
            timezoneIana: timezone,
            timezoneZone: zoneSlug,
            notificationId: notifId,
            messageId: msg.id,
            title: groupTitle,
            body: notifBody,
            senderHandle: handle,
          } satisfies ChatNotificationPayload);
        }

        // MANDATORY chunked push — gate on groupsPush, batch via array path (M6).
        // Fetch unread badge counts in a single query for all group recipients.
        const badgeCounts = await getUnreadBadgeCounts(groupRecipients);

        const pushMessages: Array<{ to: string; title: string; body: string; data: Record<string, unknown>; sound: 'default'; badge?: number; channelId: string }> = [];
        for (const recipientId of groupRecipients) {
          const canPush = await shouldSendPush(recipientId, 'group');
          if (!canPush) continue;
          const token = tokenMap.get(recipientId);
          if (!token?.startsWith('ExponentPushToken[')) continue;
          const notifId = notifIdMap.get(recipientId);
          if (notifId === undefined) continue;
          pushMessages.push({
            to: token,
            title: groupTitle,
            body: notifBody,
            data: {
              type: 'chat',
              source: 'local_chat',
              entityId: timezone,
              timezoneIana: timezone,
              timezoneZone: zoneSlug,
              notificationId: notifId,
              messageId: msg.id,
              senderHandle: handle,
            },
            sound: 'default',
            badge: (badgeCounts.get(recipientId) ?? 0),
            channelId: 'default',
          });
        }

        // Send in chunks of 100 (Expo push API limit per request).
        const CHUNK_SIZE = 100;
        for (let i = 0; i < pushMessages.length; i += CHUNK_SIZE) {
          await sendPushNotifications(pushMessages.slice(i, i + CHUNK_SIZE));
        }
      } catch (err) {
        log.error({ err }, '[room fan-out] group notification fan-out failed');
      }
    });

  });
}
