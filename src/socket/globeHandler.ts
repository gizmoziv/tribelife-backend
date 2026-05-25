import { Server, Socket } from 'socket.io';
import logger from '../lib/logger';
import { db } from '../db';
import { messages, userProfiles, notifications, notificationPreferences, blockedUsers } from '../db/schema';
import { and, eq, inArray, ne, isNotNull, or } from 'drizzle-orm';
import { checkRateLimit } from './rateLimit';
import { isValidGlobeRoom, AGE_GATE_HOURS } from '../config/globeRooms';
import { moderateMessage } from '../services/claude';
import { moderateMessageImages } from '../services/imageModeration';
import { sendPushToUser, sendPushNotifications, shouldSendPush, getUnreadBadgeCounts } from '../services/pushNotifications';
import { getGlobeMembershipsForUser } from '../services/globeMembership';
import type { ChatNotificationPayload } from '../types/chatNotification';

// ── Globe Room Event Handlers ───────────────────────────────────────────────
// Events: globe:join, globe:leave, globe:message, globe:typing

const log = logger.child({ module: 'socket:globe' });

export function registerGlobeHandlers(io: Server, socket: Socket): void {
  const userId: number = socket.data.userId;
  const handle: string = socket.data.handle;
  const createdAt: Date = socket.data.createdAt;
  const avatarUrl: string | null = socket.data.avatarUrl;

  // ── Join a Globe room ───────────────────────────────────────────────────
  // Phase 14 Bug 3 fix: two-room model.
  //   - 'globe:<slug>'      = active-viewer PRESENCE (participant counts,
  //                           typing indicators). Joined here, left on exit.
  //   - 'globe-feed:<slug>' = broadcast FEED (drives globe:message arrival
  //                           and therefore Chats-list lastMessage updates).
  //                           Auto-joined on socket connect for every
  //                           globe_room_memberships row. Survives globe:leave.
  socket.on('globe:join', (data: { slug: string }) => {
    if (!isValidGlobeRoom(data.slug)) return;

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

    // D-14: server-side posting gate — reject non-members before any DB write.
    // Town Square is transparent (every user has the auto-join row per Phase 7
    // D-02). Defense in depth — the client-side composer-hide in D-12 is
    // bypassable, so the server gate is the real enforcement point.
    const memberships = await getGlobeMembershipsForUser(userId);
    if (!memberships.has(data.slug)) {
      socket.emit('message:rejected', { reason: 'not_a_member' });
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
        await sendPushToUser(
          targetProfile?.expoPushToken,
          title,
          content.slice(0, 100),
          {
            type: 'chat',
            source: 'globe_room',
            entityId: data.slug,
            roomSlug: data.slug,
            notificationId: inserted.id,
            messageId: msg.id, // Phase 14 D-04
            senderHandle: handle,
          },
          notifyId,
        );
      }
    }

    // ── Town Square broadcast notifications ─────────────────────────────────
    // CPO request: Town Square delivers a push + Chats-tab notification for
    // EVERY message (not just @mentions), gated by the new
    // notification_preferences.town_square_push opt-out. Mirrors the Local
    // Chat (timezone room) pattern from socket/roomHandler.ts. Skips sender,
    // anyone already notified via @mention/reply, and blocked pairs.
    // Fire-and-forget — does not block the message broadcast.
    log.info({ slug: data.slug, isTownSquare: data.slug === 'town-square' }, 'globe message broadcast eligibility check');
    if (data.slug === 'town-square') {
      log.info({ msgId: msg.id }, 'town-square broadcast: starting fan-out');
      (async () => {
        try {
          // Everyone except the sender — drop the push-token filter so the
          // in-app bell + chat:notification fan-out reaches users without a
          // registered push token (common on dev / Android emulator). Push
          // delivery is filtered separately below.
          const candidates = await db
            .select({
              userId: userProfiles.userId,
              expoPushToken: userProfiles.expoPushToken,
            })
            .from(userProfiles)
            .where(ne(userProfiles.userId, userId));
          if (candidates.length === 0) return;

          const candidateIds = candidates.map((c) => c.userId);

          // Per-user opt-out (defaults to true if no preference row exists).
          const prefs = await db
            .select({
              userId: notificationPreferences.userId,
              townSquarePush: notificationPreferences.townSquarePush,
            })
            .from(notificationPreferences)
            .where(inArray(notificationPreferences.userId, candidateIds));
          const prefMap = new Map(prefs.map((p) => [p.userId, p.townSquarePush]));

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

          const alreadyNotified = notifyUserIds;
          // Eligibility for the in-app notification row + chat:notification
          // fan-out — no token requirement (push is filtered separately).
          const eligible = candidates.filter((c) => {
            if (blockedSet.has(c.userId)) return false;
            if (alreadyNotified.has(c.userId)) return false;
            const allowed = prefMap.has(c.userId) ? prefMap.get(c.userId) : true;
            return allowed;
          });
          log.info(
            { candidates: candidates.length, eligible: eligible.length, blocked: blockedSet.size, alreadyNotified: alreadyNotified.size },
            'town-square broadcast: eligibility',
          );
          if (eligible.length === 0) return;

          const badgeMap = await getUnreadBadgeCounts(eligible.map((c) => c.userId));

          // Insert notifications rows so the Chats-tab unread badge has a
          // server source of truth. Reuse type='mention' (no schema change);
          // `data.source='globe_room'` is the tap-router signal.
          const notifIdByUser = new Map<number, number>();
          const insertedRows = await db.insert(notifications).values(
            eligible.map((c) => ({
              userId: c.userId,
              type: 'mention' as const,
              title: `@${handle}`,
              body: content.slice(0, 100),
              data: {
                messageId: msg.id,
                roomId,
                senderHandle: handle,
                source: 'globe_room' as const,
                entityId: data.slug,
                roomSlug: data.slug,
              },
            })),
          ).returning({ id: notifications.id, userId: notifications.userId });
          for (const row of insertedRows) notifIdByUser.set(row.userId, row.id);

          // chat:notification fan-out — drives the in-app unread badge.
          for (const c of eligible) {
            const notifId = notifIdByUser.get(c.userId);
            if (notifId === undefined) continue;
            io.to(`user:${c.userId}`).emit('chat:notification', {
              source: 'globe_room',
              entityId: data.slug,
              roomSlug: data.slug,
              notificationId: notifId,
              messageId: msg.id,
              title: `@${handle}`,
              body: content.slice(0, 100),
              senderHandle: handle,
            } satisfies ChatNotificationPayload);
          }

          // Batch push — only users with a registered token.
          const pushBatch = eligible.filter((c) => !!c.expoPushToken).map((c) => ({
            to: c.expoPushToken as string,
            title: `@${handle}`,
            body: content.slice(0, 100),
            data: {
              type: 'chat' as const,
              source: 'globe_room' as const,
              entityId: data.slug,
              roomSlug: data.slug,
              notificationId: notifIdByUser.get(c.userId)!,
              messageId: msg.id,
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
          log.error({ err }, 'Town Square broadcast push delivery failed');
        }
      })();
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
