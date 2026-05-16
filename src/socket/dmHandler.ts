import { Server, Socket } from 'socket.io';
import logger from '../lib/logger';
import { db } from '../db';
import {
  messages,
  conversations,
  conversationParticipants,
  userProfiles,
  notifications,
  blockedUsers,
} from '../db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { moderateMessage } from '../services/claude';
import { moderateMessageImages } from '../services/imageModeration';
import { sendPushToUser, sendPushNotifications, shouldSendPush, getUnreadBadgeCounts } from '../services/pushNotifications';
import type { ChatNotificationPayload } from '../types/chatNotification';

const log = logger.child({ module: 'socket:dm' });

export function registerDmHandlers(io: Server, socket: Socket): void {
  const userId: number = socket.data.userId;
  const handle: string = socket.data.handle;

  // ── Send a direct message ─────────────────────────────────────────────
  socket.on('dm:message', async (data: { conversationId: number; content: string; replyToId?: number; mediaUrls?: string[] }) => {
    log.info({ event: 'dm_received', userId, handle, conversationId: data?.conversationId, contentLen: data?.content?.length ?? 0, mediaCount: Array.isArray(data?.mediaUrls) ? data.mediaUrls.length : 0, hasReply: !!data?.replyToId }, 'dm:message received');

    const content = data.content?.trim() ?? '';
    const mediaUrls = Array.isArray(data.mediaUrls)
      ? data.mediaUrls.filter((u): u is string => typeof u === 'string').slice(0, 4)
      : [];
    if (!content && mediaUrls.length === 0) {
      log.warn({ event: 'dm_dropped_empty', userId, conversationId: data?.conversationId }, 'dm:message dropped — empty content + no media');
      return;
    }
    if (content.length > 2000) {
      log.warn({ event: 'dm_dropped_too_long', userId, conversationId: data?.conversationId, contentLen: content.length }, 'dm:message dropped — content > 2000 chars');
      return;
    }

    // Content moderation check (skip for image-only messages)
    if (content) {
      const dmModResult = moderateMessage(content);
      if (!dmModResult.isAllowed) {
        log.warn({ event: 'dm_moderation_rejected', userId, conversationId: data?.conversationId, reason: dmModResult.reason }, 'dm:message rejected by moderation');
        socket.emit('message:rejected', { reason: dmModResult.reason });
        return;
      }
    }

    // Verify participant (must not have left)
    const participation = await db
      .select()
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, data.conversationId),
          eq(conversationParticipants.userId, userId),
          isNull(conversationParticipants.leftAt)
        )
      )
      .limit(1);

    if (participation.length === 0) {
      log.warn({ event: 'dm_dropped_not_participant', userId, conversationId: data?.conversationId }, 'dm:message dropped — sender is not an active participant');
      return;
    }

    // Fetch conversation to determine if group
    const [convo] = await db
      .select({ id: conversations.id, isGroup: conversations.isGroup, isPublic: conversations.isPublic, groupName: conversations.groupName, groupIconUrl: conversations.groupIconUrl, archivedAt: conversations.archivedAt })
      .from(conversations)
      .where(eq(conversations.id, data.conversationId))
      .limit(1);

    if (!convo) {
      log.warn({ event: 'dm_dropped_no_convo', userId, conversationId: data?.conversationId }, 'dm:message dropped — conversation not found');
      return;
    }

    const isGroup = convo.isGroup === true;

    // D-12: reject messages to archived groups
    if (isGroup && convo.archivedAt) {
      log.warn({ event: 'dm_dropped_archived', userId, conversationId: data?.conversationId }, 'dm:message dropped — group archived');
      socket.emit('message:rejected', { reason: 'Group archived' });
      return;
    }

    // Block check — only for 1:1 DMs. Groups skip this (filtering on read side).
    if (!isGroup) {
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
    }

    // Save message
    const [msg] = await db
      .insert(messages)
      .values({
        content,
        senderId: userId,
        conversationId: data.conversationId,
        replyToId: data.replyToId ?? null,
        mediaUrls: mediaUrls.length > 0 ? mediaUrls : null,
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

    const msgPayload = {
      id: msg.id,
      content,
      senderId: userId,
      senderHandle: handle,
      conversationId: data.conversationId,
      createdAt: msg.createdAt,
      replyToId: data.replyToId ?? null,
      replyTo,
      mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
    };

    // Emit to conversation room
    io.to(`conversation:${data.conversationId}`).emit('dm:message', msgPayload);
    log.info({ event: 'dm_saved_emitted', userId, conversationId: data.conversationId, messageId: msg.id, isGroup }, 'dm:message persisted + broadcast');

    // Phase 12 D-04 follow-up: broadcast a light-weight last-message update
    // so anyone currently viewing Chevra can refresh the row without
    // re-fetching. Limited to PUBLIC, non-archived groups since the row
    // preview is already public info (returned by GET /api/globe/rooms).
    if (isGroup && convo.isPublic === true && !convo.archivedAt) {
      io.emit('chevra:group-message', {
        conversationId: data.conversationId,
        name: convo.groupName ?? 'Group',
        iconUrl: convo.groupIconUrl ?? null,
        lastMessage: {
          content,
          createdAt: msg.createdAt,
          senderHandle: handle,
        },
      });
    }

    // Fire-and-forget image moderation
    if (mediaUrls.length > 0) {
      moderateMessageImages(msg.id, mediaUrls, userId, io, `conversation:${data.conversationId}`)
        .catch(err => log.error({ err }, 'DM image check failed'));
    }

    // Notify other participants
    const otherParticipants = await db
      .select({ userId: conversationParticipants.userId })
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, data.conversationId),
          isNull(conversationParticipants.leftAt)
        )
      );

    const recipients = otherParticipants.filter((p) => p.userId !== userId);

    if (isGroup) {
      const groupLabel = convo.groupName ?? 'Group';
      const defaultTitle = `@${handle} in ${groupLabel}`;
      const replyTitle = `@${handle} replied to you`;
      const notifBody = content.slice(0, 100);

      // Helper: is this recipient the reply target?
      const isReplyTarget = (id: number) => replyToSenderId !== null && id === replyToSenderId;
      const titleFor = (id: number) => isReplyTarget(id) ? replyTitle : defaultTitle;

      // Batch insert notifications; capture IDs so we can attach them to pushes
      const notifIdByUser = new Map<number, number>();
      if (recipients.length > 0) {
        const inserted = await db.insert(notifications).values(
          recipients.map((p) => ({
            userId: p.userId,
            type: 'new_dm' as const,
            title: titleFor(p.userId),
            body: notifBody,
            data: {
              conversationId: data.conversationId,
              senderHandle: handle,
              isGroup: true,
              groupName: groupLabel,
              // Phase 10 D-01 additive (10-CONTEXT.md):
              source: 'group' as const,
              entityId: data.conversationId,
            },
          }))
        ).returning({ id: notifications.id, userId: notifications.userId });
        for (const row of inserted) notifIdByUser.set(row.userId, row.id);
      }

      // Phase 10 D-03: chat-type notifications fan to `chat:notification`.
      for (const p of recipients) {
        io.to(`user:${p.userId}`).emit('chat:notification', {
          source: 'group',
          entityId: data.conversationId,
          conversationId: data.conversationId,
          groupName: groupLabel,
          notificationId: notifIdByUser.get(p.userId)!,
          title: titleFor(p.userId),
          body: notifBody,
          senderHandle: handle,
        } satisfies ChatNotificationPayload);
      }

      // Batch push notifications
      // Reply target uses 'mention' preference so they get notified even if
      // they've turned off group DM push (since they were directly addressed).
      const eligibleRecipients: { userId: number; expoPushToken: string }[] = [];
      for (const p of recipients) {
        const prefType = isReplyTarget(p.userId) ? 'mention' : 'dm';
        if (await shouldSendPush(p.userId, prefType)) {
          const [profile] = await db
            .select({ expoPushToken: userProfiles.expoPushToken })
            .from(userProfiles)
            .where(eq(userProfiles.userId, p.userId))
            .limit(1);
          if (profile?.expoPushToken) {
            eligibleRecipients.push({ userId: p.userId, expoPushToken: profile.expoPushToken });
          }
        }
      }

      // Fetch unread badge counts for all eligible users in a single query
      const badgeMap = await getUnreadBadgeCounts(eligibleRecipients.map((r) => r.userId));

      const pushMessages = eligibleRecipients.map((r) => ({
        to: r.expoPushToken,
        title: titleFor(r.userId),
        body: notifBody,
        data: {
          type: 'chat' as const,
          source: 'group' as const,
          entityId: data.conversationId,
          conversationId: data.conversationId,
          groupName: groupLabel,
          notificationId: notifIdByUser.get(r.userId)!,
          senderHandle: handle,
        },
        sound: 'default' as const,
        badge: badgeMap.get(r.userId) ?? 0,
        channelId: 'default',
      }));
      if (pushMessages.length > 0) {
        sendPushNotifications(pushMessages).catch((err) => log.error({ err }, 'Group push failed'));
      }
    } else {
      // 1:1 DM notifications — existing behavior
      for (const p of recipients) {
        const [inserted] = await db.insert(notifications).values({
          userId: p.userId,
          type: 'new_dm',
          title: `Message from @${handle}`,
          body: content.slice(0, 100),
          data: {
            conversationId: data.conversationId,
            senderHandle: handle,
            // Phase 10 D-01 additive (10-CONTEXT.md):
            source: 'dm' as const,
            entityId: data.conversationId,
          },
        }).returning({ id: notifications.id });

        // Phase 10 D-03: chat-type notifications fan to `chat:notification`.
        io.to(`user:${p.userId}`).emit('chat:notification', {
          source: 'dm',
          entityId: data.conversationId,
          conversationId: data.conversationId,
          notificationId: inserted.id,
          title: `Message from @${handle}`,
          body: content.slice(0, 100),
          senderHandle: handle,
        } satisfies ChatNotificationPayload);

        const otherProfile = await db
          .select({ expoPushToken: userProfiles.expoPushToken })
          .from(userProfiles)
          .where(eq(userProfiles.userId, p.userId))
          .limit(1);

        if (await shouldSendPush(p.userId, 'dm')) {
          await sendPushToUser(
            otherProfile[0]?.expoPushToken,
            `Message from @${handle}`,
            content.slice(0, 100),
            {
              type: 'chat',
              source: 'dm',
              entityId: data.conversationId,
              conversationId: data.conversationId,
              notificationId: inserted.id,
              senderHandle: handle,
            },
            p.userId,
          );
        }
      }
    }
  });

  // ── Join a DM conversation room ───────────────────────────────────────
  socket.on('dm:join', async (data: { conversationId: number }) => {
    const membership = await db
      .select()
      .from(conversationParticipants)
      .where(and(
        eq(conversationParticipants.conversationId, data.conversationId),
        eq(conversationParticipants.userId, userId),
        isNull(conversationParticipants.leftAt)
      ))
      .limit(1);
    if (membership.length === 0) return;
    socket.join(`conversation:${data.conversationId}`);
  });

  // ── Leave a DM conversation room ──────────────────────────────────────
  socket.on('dm:leave', (data: { conversationId: number }) => {
    socket.leave(`conversation:${data.conversationId}`);
  });
}
