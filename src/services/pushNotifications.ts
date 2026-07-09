/**
 * Expo Push Notification Service
 * Sends push notifications via Expo's push gateway (free, no Firebase required).
 */
import logger from '../lib/logger';
import { db } from '../db';
import { notificationPreferences, notifications } from '../db/schema';
import { eq, and, sql, inArray } from 'drizzle-orm';

const log = logger.child({ module: 'push' });

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  // Additive person-push enrichment (Phase A — Sender-Avatar Notifications).
  // Old clients ignore these; Expo forwards `mutableContent`/`categoryId` at the
  // top level and `data` verbatim (verified against the Expo push API).
  mutableContent?: boolean;
  categoryId?: string;
  data?: Record<string, unknown> & {
    sender?: { id: number; name: string; avatarUrl: string };
    conversation?: { id: string; title: string; isGroup: boolean };
  };
  sound?: 'default' | null;
  badge?: number;
  channelId?: string;
}

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

// Giphy host check — mirrors the moderation host-skip in imageModeration.ts and
// the Giphy CDN URLs the mobile GifButton sends (media.giphy.com/.../giphy.gif).
function isGiphyUrl(url: string): boolean {
  try {
    const host = new URL(url).host.toLowerCase();
    return host === 'giphy.com' || host.endsWith('.giphy.com');
  } catch {
    return false;
  }
}

/**
 * Notification/push body for a chat message. Text messages show their content;
 * media-only messages (empty content) get a type-appropriate fallback so the
 * notification is never blank — 'sent a GIF' for Giphy media, else 'Photo
 * message'. Mirrors the VOICE_FALLBACK precedent for voice messages.
 */
export function messageNotificationBody(content: string, mediaUrls?: string[] | null): string {
  const text = (content ?? '').trim();
  if (text) return text.slice(0, 100);
  if (mediaUrls && mediaUrls.length > 0) {
    return mediaUrls.every(isGiphyUrl) ? 'sent a GIF' : 'Photo message';
  }
  return '';
}

/**
 * Resolve a never-null avatar URL for a person-message push (Phase A). Returns
 * the sender's real DO Spaces CDN avatar when present; otherwise falls back to
 * the deterministic no-DB initials endpoint so the iOS NSE / Android Notifee
 * layers (Phases B/C) always have a fetchable image. `PUBLIC_API_URL` should be
 * the backend's public origin — a deploy requirement; when unset the returned
 * URL is path-relative (harmless for Phase A since old clients ignore it).
 */
export function resolveSenderAvatar(
  profileAvatarUrl: string | null | undefined,
  sender: { userId: number; handle: string },
): string {
  if (typeof profileAvatarUrl === 'string' && profileAvatarUrl.length > 0) {
    return profileAvatarUrl;
  }
  const base = process.env.PUBLIC_API_URL ?? '';
  return `${base}/api/avatars/initials/${sender.userId}.png?h=${encodeURIComponent(sender.handle)}`;
}

export async function sendPushNotifications(
  messages: PushMessage[]
): Promise<ExpoTicket[]> {
  if (messages.length === 0) return [];

  // Filter out empty/invalid tokens
  const valid = messages.filter(
    (m) => m.to && m.to.startsWith('ExponentPushToken[')
  );

  if (valid.length === 0) return [];

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Accept-Encoding': 'gzip, deflate',
    };

    if (process.env.EXPO_ACCESS_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
    }

    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(valid),
    });

    const result = await response.json() as { data: ExpoTicket[] };
    return result.data ?? [];
  } catch (err) {
    log.error({ err }, 'Failed to send push notifications');
    return [];
  }
}

/**
 * Count unread notifications for a user. Used to populate the app icon
 * badge on iOS. Industry-standard behavior: badge reflects total unread
 * items across the app.
 */
export async function getUnreadBadgeCount(userId: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)));
  return row?.count ?? 0;
}

/**
 * Batched version: count unread notifications for many users in a single
 * query. Returns a Map<userId, count>. Users with zero unread are omitted
 * from the map — callers should treat missing entries as zero.
 */
export async function getUnreadBadgeCounts(userIds: number[]): Promise<Map<number, number>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({
      userId: notifications.userId,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(notifications)
    .where(and(
      eq(notifications.isRead, false),
      inArray(notifications.userId, userIds),
    ))
    .groupBy(notifications.userId);
  const map = new Map<number, number>();
  for (const r of rows) map.set(r.userId, r.count);
  return map;
}

export async function sendPushToUser(
  expoPushToken: string | null | undefined,
  title: string,
  body: string,
  data?: Record<string, unknown>,
  userId?: number,
): Promise<void> {
  if (!expoPushToken) return;

  // Compute badge count: current unread + 1 for this notification (which
  // has typically just been inserted but may not be committed yet when this
  // runs concurrently — adding 1 avoids off-by-one on rapid fire).
  let badge: number | undefined;
  if (userId !== undefined) {
    const unread = await getUnreadBadgeCount(userId);
    badge = unread;
  }

  await sendPushNotifications([
    {
      to: expoPushToken,
      title,
      body,
      data,
      sound: 'default',
      badge,
      channelId: 'default',
    },
  ]);
}

export async function shouldSendPush(
  userId: number,
  notificationType: 'mention' | 'beacon_match' | 'dm' | 'group'
): Promise<boolean> {
  const [prefs] = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId))
    .limit(1);

  if (!prefs) return true;

  switch (notificationType) {
    case 'mention': return prefs.dmsPush;
    case 'beacon_match': return prefs.beaconMatchesPush;
    case 'dm': return prefs.dmsPush;
    case 'group': return prefs.groupsPush;
  }
}
