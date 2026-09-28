// Phase 38.1 (D-00d, D-02, D-03): notifies newly-added @mentions on a message
// EDIT. Fired via setImmediate AFTER the PATCH response so the edit round-trip
// never waits on notification fan-out (T-38.1-14). Mirrors, per surface, the
// exact row/emit/push shapes the send-path handlers already use — see
// roomHandler.ts (local_chat), globeHandler.ts (globe_room), and dmHandler.ts
// (group) mention notify loops. Removed mentions produce no action (D-03).
import { Server } from 'socket.io';
import { db } from '../db';
import { notifications, userProfiles } from '../db/schema';
import { eq } from 'drizzle-orm';
import {
  shouldSendPush,
  messageNotificationBody,
  resolveSenderAvatar,
  resolveGroupAvatar,
  deliverPersonPush,
} from '../services/pushNotifications';
import { isUserActivelyViewing, canonicalViewingKey } from '../socket/activeViewing';
import type { ChatNotificationPayload } from '../types/chatNotification';

export type EditSurface =
  | { kind: 'local_chat'; roomId: string; zoneSlug: string; timezoneIana: string }
  | { kind: 'globe_room'; slug: string; roomId: string }
  | { kind: 'group'; conversationId: number; groupName: string; groupIconUrl: string | null };

export async function notifyEditAddedMentions(args: {
  io: Server;
  messageId: number;
  surface: EditSurface;
  senderId: number;
  senderHandle: string;
  senderAvatarUrl: string | null;
  content: string;
  targetIds: number[];
}): Promise<void> {
  const { io, messageId, surface, senderId, senderHandle, senderAvatarUrl, content, targetIds } = args;

  const title = `@${senderHandle} mentioned you`;
  const body = messageNotificationBody(content, null);

  const viewingKey =
    surface.kind === 'local_chat'
      ? canonicalViewingKey(surface.roomId)
      : surface.kind === 'globe_room'
        ? 'globe:' + surface.slug
        : `conversation:${surface.conversationId}`;

  for (const targetId of targetIds) {
    try {
      if (await isUserActivelyViewing(io, targetId, viewingKey)) continue;

      let data: Record<string, unknown>;
      let payload: ChatNotificationPayload;

      if (surface.kind === 'local_chat') {
        data = {
          messageId,
          roomId: surface.roomId,
          senderHandle,
          source: 'local_chat' as const,
          entityId: surface.timezoneIana,
          timezoneIana: surface.timezoneIana,
          timezoneZone: surface.zoneSlug,
        };
        payload = {
          source: 'local_chat',
          entityId: surface.timezoneIana,
          timezoneIana: surface.timezoneIana,
          timezoneZone: surface.zoneSlug,
          notificationId: 0,
          messageId,
          title,
          body,
          senderHandle,
        } satisfies ChatNotificationPayload;
      } else if (surface.kind === 'globe_room') {
        data = {
          messageId,
          roomId: surface.roomId,
          globeSlug: surface.slug,
          senderHandle,
          source: 'globe_room' as const,
          entityId: surface.slug,
          roomSlug: surface.slug,
        };
        payload = {
          source: 'globe_room',
          entityId: surface.slug,
          roomSlug: surface.slug,
          notificationId: 0,
          messageId,
          title,
          body,
          senderHandle,
        } satisfies ChatNotificationPayload;
      } else {
        data = {
          conversationId: surface.conversationId,
          senderHandle,
          isGroup: true,
          groupName: surface.groupName,
          source: 'group' as const,
          entityId: surface.conversationId,
        };
        payload = {
          source: 'group',
          entityId: surface.conversationId,
          conversationId: surface.conversationId,
          groupName: surface.groupName,
          notificationId: 0,
          messageId,
          title,
          body,
          senderHandle,
        } satisfies ChatNotificationPayload;
      }

      const [inserted] = await db.insert(notifications).values({
        userId: targetId,
        type: 'mention',
        title,
        body,
        data,
      }).returning({ id: notifications.id });

      payload = { ...payload, notificationId: inserted.id };

      io.to(`user:${targetId}`).emit('chat:notification', payload);

      if (await shouldSendPush(targetId, 'mention')) {
        const [targetProfile] = await db
          .select({ expoPushToken: userProfiles.expoPushToken })
          .from(userProfiles)
          .where(eq(userProfiles.userId, targetId))
          .limit(1);
        const token = targetProfile?.expoPushToken;

        const avatarUrl =
          surface.kind === 'group'
            ? resolveGroupAvatar(surface.groupIconUrl, {
                conversationId: surface.conversationId,
                groupName: surface.groupName,
              })
            : resolveSenderAvatar(senderAvatarUrl, { userId: senderId, handle: senderHandle });

        const conversationForPush =
          surface.kind === 'local_chat'
            ? { id: surface.roomId, title: surface.zoneSlug, isGroup: true }
            : surface.kind === 'globe_room'
              ? { id: surface.slug, title: surface.slug, isGroup: true }
              : { id: String(surface.conversationId), title: surface.groupName, isGroup: true };

        await deliverPersonPush({
          recipientId: targetId,
          legacyToken: token,
          message: {
            to: token ?? '',
            title,
            body,
            mutableContent: true,
            categoryId: 'message',
            data: {
              type: 'chat',
              ...data,
              notificationId: inserted.id,
              sender: { id: senderId, name: senderHandle, avatarUrl },
              conversation: conversationForPush,
            },
            sound: 'default',
          },
        });
      }
    } catch (err) {
      console.error('[chat/edit-mention]', err);
    }
  }
}
