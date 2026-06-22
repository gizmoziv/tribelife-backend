import { Server, Socket } from 'socket.io';
import logger from '../lib/logger';
import { db } from '../db';
import { messages, userProfiles, notifications } from '../db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { checkRateLimit } from './rateLimit';
import { isValidGlobeRoom, AGE_GATE_HOURS } from '../config/globeRooms';
import { moderateMessage } from '../services/claude';
import { moderateMessageImages } from '../services/imageModeration';
import { sendPushNotifications, shouldSendPush, getUnreadBadgeCounts } from '../services/pushNotifications';
import { isUserActivelyViewing } from './activeViewing';
import { getGlobeMembershipsForUser, getGlobeMembershipsForRoomSlug } from '../services/globeMembership';
import type { ChatNotificationPayload } from '../types/chatNotification';
import { isValidTimezoneRoom, getZoneForTimezone } from '../config/timezoneZones';
import { timezoneRoomId } from '../lib/timezoneRoomAccess';

// ── Globe Room Event Handlers ───────────────────────────────────────────────
// Events: globe:join, globe:leave, globe:message, globe:typing

const log = logger.child({ module: 'socket:globe' });

export function registerGlobeHandlers(io: Server, socket: Socket): void {
  const userId: number = socket.data.userId;
  const handle: string = socket.data.handle;
  const createdAt: Date = socket.data.createdAt;
  const avatarUrl: string | null = socket.data.avatarUrl;

  // Phase 16 P0 (TZRM send/receive fix): non-native timezone rooms are a PAID
  // feature. Membership rows survive downgrade (D-09 soft-membership), so a
  // membership check alone is NOT sufficient — re-check live premium/org-admin
  // capability at event time. The caller's own (native) zone is always allowed.
  // Mirrors the auto-join gate in socket/index.ts:263-278 + the REST read gate.
  const canAccessNonNativeTimezone = (slug: string): boolean => {
    if (slug === getZoneForTimezone(socket.data.timezone)) return true; // native = implicit access
    const isPremiumActive =
      socket.data.isPremium &&
      (!socket.data.premiumExpiresAt ||
        (socket.data.premiumExpiresAt as Date) > new Date());
    return Boolean(isPremiumActive) || Boolean(socket.data.isOrgAdmin);
  };

  // ── Join a Globe room ───────────────────────────────────────────────────
  // Phase 14 Bug 3 fix: two-room model.
  //   - 'globe:<slug>'      = active-viewer PRESENCE (participant counts,
  //                           typing indicators). Joined here, left on exit.
  //   - 'globe-feed:<slug>' = broadcast FEED (drives globe:message arrival
  //                           and therefore Chats-list lastMessage updates).
  //                           Auto-joined on socket connect for every
  //                           globe_room_memberships row. Survives globe:leave.
  socket.on('globe:join', (data: { slug: string }) => {
    const joinIsGlobe = isValidGlobeRoom(data.slug);
    const joinIsTimezone = isValidTimezoneRoom(data.slug);
    if (!joinIsGlobe && !joinIsTimezone) return;
    // Phase 16 P0: gate join to a non-native timezone (paid) room — without this
    // an active viewer is never added to globe-feed:<slug> and never receives
    // live messages (receive was broken too), and a free user could otherwise
    // subscribe to a paid room's feed.
    if (joinIsTimezone && !canAccessNonNativeTimezone(data.slug)) return;

    // Leave previous PRESENCE rooms only — feed subscriptions persist so the
    // user keeps receiving Chats-list updates for every joined globe room.
    for (const room of socket.rooms) {
      if (room.startsWith('globe:') && !room.startsWith('globe-feed:')) {
        socket.leave(room);
      }
    }

    const roomId = 'globe:' + data.slug;
    socket.join(roomId);
    // Also subscribe to the feed for this room. Idempotent for member rooms
    // (already auto-joined on connect); required for non-member previewers
    // so they receive in-room messages while the screen is open.
    socket.join('globe-feed:' + data.slug);

    const count = io.sockets.adapter.rooms.get(roomId)?.size ?? 0;
    io.to(roomId).emit('globe:participants', { slug: data.slug, count });
  });

  // ── Leave a Globe room ──────────────────────────────────────────────────
  socket.on('globe:leave', (data: { slug: string }) => {
    const roomId = 'globe:' + data.slug;
    socket.leave(roomId);
    // Deliberately DO NOT leave 'globe-feed:<slug>' — the user stays
    // subscribed so their Chats list keeps updating for this room even after
    // they navigate away from the screen. Bug 3 root cause: pre-fix the
    // leave loop in globe:join (and this handler) removed the user from the
    // only socket room delivering globe:message, so Town Square (and any
    // other regional globe room) stopped live-updating after one visit.

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
    const isGlobe = isValidGlobeRoom(data.slug);
    const isTimezone = isValidTimezoneRoom(data.slug);
    if (!isGlobe && !isTimezone) return;

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
    // Timezone rooms persist/key on the canonical timezone:<slug> roomId (matches
    // migration 0019 + the REST read shim in globe.ts:386); globe rooms use globe:<slug>.
    const roomId = isTimezone ? timezoneRoomId(data.slug) : 'globe:' + data.slug;
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

    // D-14: server-side posting gate — reject non-members before any DB write.
    // Town Square is transparent (every user has the auto-join row per Phase 7
    // D-02). Defense in depth — the client-side composer-hide in D-12 is
    // bypassable, so the server gate is the real enforcement point.
    const memberships = await getGlobeMembershipsForUser(userId);
    if (!memberships.has(data.slug)) {
      socket.emit('message:rejected', { reason: 'not_a_member' });
      return;
    }

    // Phase 16 P0: "Premium + explicitly joined" gate. The membership row above
    // proves "explicitly joined", but rows survive downgrade (D-09), so re-check
    // live premium/org-admin for non-native timezone rooms before the DB write.
    if (isTimezone && !canAccessNonNativeTimezone(data.slug)) {
      socket.emit('message:rejected', { reason: 'premium_required' });
      return;
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
      // NOTIF-03: intersect with globe room membership — a mention of a handle
      // that is NOT a member of this room produces no notification for that handle.
      const roomMemberIds = await getGlobeMembershipsForRoomSlug(data.slug);
      mentionedUserIds = mentionedProfiles
        .map((p) => p.userId)
        .filter((id) => roomMemberIds.has(id));
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

    // Broadcast to room. Phase 14 Bug 3 fix: emit to the FEED room so every
    // subscriber (active viewers + auto-joined members on the Chats tab) gets
    // the message. Active viewers also belong to the feed room because
    // globe:join subscribes them to both, so they still receive in-room
    // messages and the count of recipients is correct.
    io.to('globe-feed:' + data.slug).emit('globe:message', {
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
      // Carry a minimal lastMessage preview so non-member clients can keep
      // their Chevra discovery tile's lastMessage current without polling
      // /api/globe/rooms. Members already get the preview via globe:message
      // (in-room) and chat:notification (Chats list).
      senderHandle: handle,
      content,
      createdAt: msg.createdAt,
    });

    // Build the full set of directed targets: explicit @mentions + reply target
    const directedTargets = new Set<number>(mentionedUserIds);
    if (replyToSenderId && replyToSenderId !== userId) {
      directedTargets.add(replyToSenderId);
    }
    const explicitMentions = new Set(mentionedUserIds);

    // ── Mention / reply notifications (directed targets only) ─────────────
    // M5: directed targets get ONLY the type:'mention' row — NOT also a group row.
    // 260621-un7: viewing identity for this globe surface. data.slug is the zone
    // slug; both Globe and Local Chat of this zone normalize to `globe:<slug>`.
    const viewingRoomKey = 'globe:' + data.slug;

    for (const notifyId of directedTargets) {
      if (notifyId === userId) continue;
      // 260621-un7: skip emit + row + push if actively viewing this room.
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
          roomId,
          globeSlug: data.slug,
          senderHandle: handle,
          // Phase 10 D-01 additive (10-CONTEXT.md):
          source: 'globe_room' as const,
          entityId: data.slug,
          roomSlug: data.slug,
        },
      }).returning({ id: notifications.id });

      // Phase 10 D-03: chat-type notifications fan to `chat:notification`.
      io.to(`user:${notifyId}`).emit('chat:notification', {
        source: 'globe_room',
        entityId: data.slug,
        roomSlug: data.slug,
        notificationId: inserted.id,
        messageId: msg.id, // Phase 14 D-04: deep-link to the mentioning message
        title,
        body: content.slice(0, 100),
        senderHandle: handle,
      } satisfies ChatNotificationPayload);

      const [targetProfile] = await db
        .select({ expoPushToken: userProfiles.expoPushToken })
        .from(userProfiles)
        .where(eq(userProfiles.userId, notifyId))
        .limit(1);

      if (await shouldSendPush(notifyId, 'mention')) {
        const token = targetProfile?.expoPushToken;
        if (token?.startsWith('ExponentPushToken[')) {
          await sendPushNotifications([{
            to: token,
            title,
            body: content.slice(0, 100),
            data: {
              type: 'chat',
              source: 'globe_room',
              entityId: data.slug,
              roomSlug: data.slug,
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
    // M6). All globe room members EXCEPT sender (D-17) and directed targets (M5)
    // get a stored type:'group' row + groupsPush-gated push.
    // Town Square (slug='town-square', autoJoin=true) IS included — it uses
    // source:'globe_room' with entityId='town-square' (no separate source).
    // D-16: this handler only processes user sends. REST routes (groups.ts)
    // handle system messages and do NOT pass through here — no group rows for joins.
    const slug = data.slug;
    setImmediate(async () => {
      try {
        // Fetch all globe room members for this slug (includes Town Square members).
        const roomMemberSet = await getGlobeMembershipsForRoomSlug(slug);
        // Exclude sender (D-17).
        roomMemberSet.delete(userId);
        if (roomMemberSet.size === 0) return;

        // M5: exclude directed targets — they already got a mention row.
        const groupCandidates = [...roomMemberSet].filter((id) => !directedTargets.has(id));
        if (groupCandidates.length === 0) return;

        // 260621-un7: drop members actively viewing this room so no row is
        // inserted and no emit/push fires (all 3 channels skipped together).
        const groupRecipients: number[] = [];
        for (const rid of groupCandidates) {
          if (await isUserActivelyViewing(io, rid, 'globe:' + slug)) continue;
          groupRecipients.push(rid);
        }
        if (groupRecipients.length === 0) return;

        // Batched token fetch in ONE query (M6 — no N selects).
        const profileRows = await db
          .select({ userId: userProfiles.userId, expoPushToken: userProfiles.expoPushToken })
          .from(userProfiles)
          .where(inArray(userProfiles.userId, groupRecipients));
        const tokenMap = new Map<number, string | null>(
          profileRows.map((r) => [r.userId, r.expoPushToken ?? null]),
        );

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
            roomId,
            globeSlug: slug,
            senderHandle: handle,
            source: 'globe_room' as const,
            entityId: slug,
            roomSlug: slug,
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
            source: 'globe_room',
            entityId: slug,
            roomSlug: slug,
            notificationId: notifId,
            messageId: msg.id,
            title: groupTitle,
            body: notifBody,
            senderHandle: handle,
          } satisfies ChatNotificationPayload);
        }

        // MANDATORY chunked push — gate on groupsPush, batch via array path (M6).
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
              source: 'globe_room',
              entityId: slug,
              roomSlug: slug,
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
        log.error({ err }, '[globe fan-out] group notification fan-out failed');
      }
    });

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
