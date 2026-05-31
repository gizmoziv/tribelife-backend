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
import { eq, and, isNull, inArray } from 'drizzle-orm';
import { moderateMessage } from '../services/claude';
import { moderateMessageImages } from '../services/imageModeration';
import { sendPushNotifications, shouldSendPush, getUnreadBadgeCounts } from '../services/pushNotifications';
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
      const notifBody = content.slice(0, 100);

      // Parse @mentions in the group message (reuse roomHandler pattern).
      // Resolve handles → userIds, then intersect with the sender-excluded
      // recipient set so a mention of a non-member produces no notification
      // (NOTIF-03).
      const mentionedHandles = [...content.matchAll(/@([a-zA-Z0-9_]+)/g)].map(
        (m) => m[1].toLowerCase(),
      );
      let mentionedInGroup: number[] = [];
      if (mentionedHandles.length > 0) {
        const mentionedProfiles = await db
          .select({ userId: userProfiles.userId })
          .from(userProfiles)
          .where(inArray(userProfiles.handle, mentionedHandles));
        const recipientIds = new Set(recipients.map((p) => p.userId));
        mentionedInGroup = mentionedProfiles
          .map((p) => p.userId)
          .filter((id) => recipientIds.has(id));
      }

      // Build directed target set: mentioned group members ∪ reply target
      // (if they are a recipient). Sender is already excluded from recipients.
      const directedTargets = new Set<number>(mentionedInGroup);
      if (replyToSenderId !== null) {
        const recipientIds = new Set(recipients.map((p) => p.userId));
        if (recipientIds.has(replyToSenderId)) {
          directedTargets.add(replyToSenderId);
        }
      }
      const explicitMentions = new Set(mentionedInGroup);

      // ── Mention / reply notifications (directed targets only) ────────────
      // M5: directed targets get ONLY the type:'mention' row (DMs tab) — NOT
      // also a type:'group' row. They are excluded from the group fan-out below.
      for (const targetId of directedTargets) {
        const isReplyTarget = targetId === replyToSenderId && !explicitMentions.has(targetId);
        const title = isReplyTarget ? `@${handle} replied to you` : `@${handle} mentioned you`;

        const [inserted] = await db.insert(notifications).values({
          userId: targetId,
          type: 'mention' as const,
          title,
          body: notifBody,
          data: {
            conversationId: data.conversationId,
            senderHandle: handle,
            isGroup: true,
            groupName: groupLabel,
            source: 'group' as const,
            entityId: data.conversationId,
          },
        }).returning({ id: notifications.id });

        io.to(`user:${targetId}`).emit('chat:notification', {
          source: 'group',
          entityId: data.conversationId,
          conversationId: data.conversationId,
          groupName: groupLabel,
          notificationId: inserted.id,
          messageId: msg.id,
          title,
          body: notifBody,
          senderHandle: handle,
        } satisfies ChatNotificationPayload);

        if (await shouldSendPush(targetId, 'mention')) {
          const [targetProfile] = await db
            .select({ expoPushToken: userProfiles.expoPushToken })
            .from(userProfiles)
            .where(eq(userProfiles.userId, targetId))
            .limit(1);
          const token = targetProfile?.expoPushToken;
          if (token?.startsWith('ExponentPushToken[')) {
            await sendPushNotifications([{
              to: token,
              title,
              body: notifBody,
              data: {
                type: 'chat',
                source: 'group',
                entityId: data.conversationId,
                conversationId: data.conversationId,
                groupName: groupLabel,
                notificationId: inserted.id,
                messageId: msg.id,
                senderHandle: handle,
              },
              sound: 'default',
            }]);
          }
        }
      }

      // ── Plain-message group fan-out (D-13/D-14) ──────────────────────────
      // All non-sender participants EXCEPT directed targets (M5) get a stored
      // type:'group' row (source:'group', entityId=conversationId) + groupsPush-
      // gated push. Runs post-broadcast (fan-out deferred after dm:message emit).
      // D-16: group join/system messages come from REST (groups.ts:402-430) and
      // do NOT pass through this handler — no group rows for system messages.
      // Sender already excluded: recipients = participants \ {sender}.
      const groupFanRecipients = recipients.filter((p) => !directedTargets.has(p.userId));

      if (groupFanRecipients.length > 0) {
        setImmediate(async () => {
          try {
            const fanRecipientIds = groupFanRecipients.map((p) => p.userId);

            // Batched token fetch in ONE query (M6 — no N selects).
            const profileRows = await db
              .select({ userId: userProfiles.userId, expoPushToken: userProfiles.expoPushToken })
              .from(userProfiles)
              .where(inArray(userProfiles.userId, fanRecipientIds));
            const tokenMap = new Map<number, string | null>(
              profileRows.map((r) => [r.userId, r.expoPushToken ?? null]),
            );

            // MANDATORY batched notification INSERT (single multi-row insert, M6).
            // Reuses the exact payload shape from dmHandler.ts:263-283 (group mention path).
            const insertValues = fanRecipientIds.map((recipientId) => ({
              userId: recipientId,
              type: 'group' as const,
              title: `@${handle} in ${groupLabel}`,
              body: notifBody,
              data: {
                conversationId: data.conversationId,
                senderHandle: handle,
                isGroup: true,
                groupName: groupLabel,
                source: 'group' as const,
                entityId: data.conversationId,
              },
            }));

            const insertedRows = await db
              .insert(notifications)
              .values(insertValues)
              .returning({ id: notifications.id, userId: notifications.userId });

            const notifIdMap = new Map<number, number>(
              insertedRows.map((r) => [r.userId, r.id]),
            );

            // Emit chat:notification to each recipient's personal room.
            for (const recipientId of fanRecipientIds) {
              const notifId = notifIdMap.get(recipientId);
              if (notifId === undefined) continue;
              io.to(`user:${recipientId}`).emit('chat:notification', {
                source: 'group',
                entityId: data.conversationId,
                conversationId: data.conversationId,
                groupName: groupLabel,
                notificationId: notifId,
                messageId: msg.id,
                title: `@${handle} in ${groupLabel}`,
                body: notifBody,
                senderHandle: handle,
              } satisfies ChatNotificationPayload);
            }

            // MANDATORY chunked push — gate on groupsPush, batch via array path (M6).
            const badgeCounts = await getUnreadBadgeCounts(fanRecipientIds);

            const pushMessages: Array<{ to: string; title: string; body: string; data: Record<string, unknown>; sound: 'default'; badge?: number; channelId: string }> = [];
            for (const recipientId of fanRecipientIds) {
              const canPush = await shouldSendPush(recipientId, 'group');
              if (!canPush) continue;
              const token = tokenMap.get(recipientId);
              if (!token?.startsWith('ExponentPushToken[')) continue;
              const notifId = notifIdMap.get(recipientId);
              if (notifId === undefined) continue;
              pushMessages.push({
                to: token,
                title: `@${handle} in ${groupLabel}`,
                body: notifBody,
                data: {
                  type: 'chat',
                  source: 'group',
                  entityId: data.conversationId,
                  conversationId: data.conversationId,
                  groupName: groupLabel,
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
            log.error({ err }, '[dm group fan-out] group notification fan-out failed');
          }
        });
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
          messageId: msg.id, // Phase 14 D-04: deep-link to the new message
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
          const token = otherProfile[0]?.expoPushToken;
          if (token?.startsWith('ExponentPushToken[')) {
            await sendPushNotifications([{
              to: token,
              title: `Message from @${handle}`,
              body: content.slice(0, 100),
              data: {
                type: 'chat',
                source: 'dm',
                entityId: data.conversationId,
                conversationId: data.conversationId,
                notificationId: inserted.id,
                messageId: msg.id, // Phase 14 D-04
                senderHandle: handle,
              },
              sound: 'default',
            }]);
          }
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
