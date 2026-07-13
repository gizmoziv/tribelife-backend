/**
 * Expo Push Notification Service
 * Sends push notifications via Expo's push gateway (free, no Firebase required).
 */
import logger from '../lib/logger';
import { db } from '../db';
import { notificationPreferences, notifications, deviceTokens } from '../db/schema';
import { eq, and, sql, inArray } from 'drizzle-orm';
import { sendFcmDataMessage, sendFcmNotificationMessage } from './fcm';
import { getBellSummary, getBellSummaries, bellTotal } from './notificationSummary';

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

/**
 * Resolve a never-null avatar URL for a GROUP-message push. Mirrors
 * `resolveSenderAvatar` but keyed on the GROUP: returns the group's icon URL
 * when present; otherwise the deterministic no-DB initials endpoint keyed on
 * the conversation id + group name, so initials + color derive from the group
 * (not the sender). Used so group message pushes show the group's image while
 * the notification text still names the sender.
 */
export function resolveGroupAvatar(
  groupIconUrl: string | null | undefined,
  group: { conversationId: number | string; groupName: string },
): string {
  if (typeof groupIconUrl === 'string' && groupIconUrl.length > 0) {
    return groupIconUrl;
  }
  const base = process.env.PUBLIC_API_URL ?? '';
  return `${base}/api/avatars/initials/${group.conversationId}.png?h=${encodeURIComponent(group.groupName)}`;
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

// ─────────────────────────────────────────────
// PHASE C — per-token routing (Expo gateway vs raw FCM), flag-gated
// ─────────────────────────────────────────────
// Single chokepoint reused by all person-push sites + sendPushToUser
// (LOCKED DECISION 4). With ANDROID_FCM_ENABLED off the send path is
// BYTE-FOR-BYTE the legacy Expo behavior; the FCM branches are unreachable.

export type DeviceTokenRow = { token: string; tokenType: 'expo' | 'fcm'; platform: string };

/** Master flag — default OFF. When off, all routing helpers reproduce legacy Expo behavior. */
export function androidFcmEnabled(): boolean {
  return process.env.ANDROID_FCM_ENABLED === 'true';
}

/** One query → device_tokens grouped by userId. Missing users map to no entry (treat as []). */
export async function getDeviceTokens(userIds: number[]): Promise<Map<number, DeviceTokenRow[]>> {
  const map = new Map<number, DeviceTokenRow[]>();
  if (userIds.length === 0) return map;
  const rows = await db
    .select({
      userId: deviceTokens.userId,
      token: deviceTokens.token,
      tokenType: deviceTokens.tokenType,
      platform: deviceTokens.platform,
    })
    .from(deviceTokens)
    .where(inArray(deviceTokens.userId, userIds));
  for (const r of rows) {
    const list = map.get(r.userId) ?? [];
    list.push({ token: r.token, tokenType: r.tokenType as 'expo' | 'fcm', platform: r.platform });
    map.set(r.userId, list);
  }
  return map;
}

/** Delete a dead FCM token (firebase-admin returned 'unregistered'). Best-effort. */
async function pruneDeviceToken(token: string): Promise<void> {
  try {
    await db.delete(deviceTokens).where(eq(deviceTokens.token, token));
  } catch (err) {
    log.error({ err }, 'Failed to prune unregistered FCM token');
  }
}

/** Coerce an arbitrary data object to an all-string map (FCM requires string values). */
function coerceStringMap(obj: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!obj) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

/**
 * FCM data block for a person push. JSON-stringifies `sender`/`conversation`
 * (and any nested objects) and carries the scalar fields + `body` as strings,
 * mirroring the Phase A Expo payload so the Android MessagingStyle handler has
 * everything it needs.
 */
function personFcmData(message: PushMessage): Record<string, string> {
  const data = coerceStringMap(message.data);
  data.body = message.body ?? '';
  if (message.title) data.title = message.title;
  return data;
}

/**
 * Deliver ONE person push, routed per the recipient's device tokens.
 * Flag OFF → verbatim legacy: send via Expo iff legacyToken is an Expo token.
 * Flag ON  → per device_tokens row: expo → Expo gateway, fcm → data-only FCM
 *            (prune on 'unregistered'); no rows → legacy Expo fallback.
 * NOTE: `message.to` MUST already be `legacyToken` so the flag-OFF send is
 * byte-identical to the previous inline call.
 */
export async function deliverPersonPush(args: {
  recipientId: number;
  legacyToken: string | null | undefined;
  message: PushMessage;
}): Promise<void> {
  const { recipientId, legacyToken, message } = args;

  if (!androidFcmEnabled()) {
    if (legacyToken?.startsWith('ExponentPushToken[')) {
      await sendPushNotifications([message]);
    }
    return;
  }

  const rows = (await getDeviceTokens([recipientId])).get(recipientId);
  if (!rows || rows.length === 0) {
    // Old client that never registered a device_tokens row → legacy fallback.
    if (legacyToken?.startsWith('ExponentPushToken[')) {
      await sendPushNotifications([message]);
    }
    return;
  }

  const fcmData = personFcmData(message);
  for (const row of rows) {
    if (row.tokenType === 'expo') {
      await sendPushNotifications([{ ...message, to: row.token }]);
    } else if (row.tokenType === 'fcm') {
      const result = await sendFcmDataMessage(row.token, fcmData);
      if (result === 'unregistered') await pruneDeviceToken(row.token);
    }
  }
}

/**
 * Batched person fan-out (group / room / globe). Flag OFF → collect the
 * Expo-token messages and send in 100-item chunks (preserves the existing Expo
 * chunking exactly). Flag ON → route each recipient per device_tokens, still
 * chunking the Expo-bound messages by 100 and sending FCM per token.
 */
export async function deliverPersonPushBatch(items: {
  recipientId: number;
  legacyToken: string | null | undefined;
  message: PushMessage;
}[]): Promise<void> {
  if (items.length === 0) return;
  const CHUNK_SIZE = 100;

  if (!androidFcmEnabled()) {
    const pushMessages = items
      .filter((it) => it.legacyToken?.startsWith('ExponentPushToken['))
      .map((it) => it.message);
    for (let i = 0; i < pushMessages.length; i += CHUNK_SIZE) {
      await sendPushNotifications(pushMessages.slice(i, i + CHUNK_SIZE));
    }
    return;
  }

  const map = await getDeviceTokens(items.map((it) => it.recipientId));
  const expoMessages: PushMessage[] = [];
  const fcmSends: { token: string; data: Record<string, string> }[] = [];
  for (const it of items) {
    const rows = map.get(it.recipientId);
    if (!rows || rows.length === 0) {
      if (it.legacyToken?.startsWith('ExponentPushToken[')) expoMessages.push(it.message);
      continue;
    }
    const fcmData = personFcmData(it.message);
    for (const row of rows) {
      if (row.tokenType === 'expo') expoMessages.push({ ...it.message, to: row.token });
      else if (row.tokenType === 'fcm') fcmSends.push({ token: row.token, data: fcmData });
    }
  }

  for (let i = 0; i < expoMessages.length; i += CHUNK_SIZE) {
    await sendPushNotifications(expoMessages.slice(i, i + CHUNK_SIZE));
  }
  for (const s of fcmSends) {
    const result = await sendFcmDataMessage(s.token, s.data);
    if (result === 'unregistered') await pruneDeviceToken(s.token);
  }
}

/**
 * App-icon badge value for one user = the BELL TOTAL (sum of the
 * /api/notifications/summary buckets), via the shared getBellSummary — the SAME
 * source of truth the summary endpoint uses, so the pushed OS badge and the
 * in-app badge sync can never diverge. Deliberately NOT a raw unread-rows count:
 * that both inflated the badge (per-message, not per-conversation) and mismatched
 * what the app clears to, which is what left the badge stuck until app restart
 * (v1.13 Phase 1 #2). Excludes non-bell types (org_invite, news_breaking, …).
 */
export async function getUnreadBadgeCount(userId: number): Promise<number> {
  return bellTotal(await getBellSummary(userId));
}

/**
 * Batched version for the group/room/globe fan-out badge path. Returns
 * Map<userId, bellTotal>. Users whose bell total is zero are omitted (callers
 * treat missing as zero) — preserves the prior contract; fan-out recipients of a
 * new message always have ≥1 so this never suppresses a needed badge.
 */
export async function getUnreadBadgeCounts(userIds: number[]): Promise<Map<number, number>> {
  const summaries = await getBellSummaries(userIds);
  const map = new Map<number, number>();
  for (const [uid, s] of summaries) {
    const total = bellTotal(s);
    if (total > 0) map.set(uid, total);
  }
  return map;
}

export async function sendPushToUser(
  expoPushToken: string | null | undefined,
  title: string,
  body: string,
  data?: Record<string, unknown>,
  userId?: number,
): Promise<void> {
  // Flag OFF → verbatim legacy Expo-only behavior (byte-for-byte, plan-check F5).
  if (!androidFcmEnabled()) {
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
    return;
  }

  // Flag ON — non-person push (beacon_match / news / moderation / system). On the
  // new Android build the service-wins plugin removes the Expo FirebaseMessaging
  // service, so FCM-token devices must be reached via FCM (LOCKED DECISION 4).
  // Route per device_tokens when we have a userId; otherwise stay Expo-only.
  if (userId !== undefined) {
    const rows = (await getDeviceTokens([userId])).get(userId);
    if (rows && rows.length > 0) {
      const badge = await getUnreadBadgeCount(userId);
      const fcmData = coerceStringMap(data);
      for (const row of rows) {
        if (row.tokenType === 'expo') {
          await sendPushNotifications([
            { to: row.token, title, body, data, sound: 'default', badge, channelId: 'default' },
          ]);
        } else if (row.tokenType === 'fcm') {
          // Non-person → FCM `notification` message (Android auto-displays it).
          const result = await sendFcmNotificationMessage(row.token, title, body, fcmData);
          if (result === 'unregistered') await pruneDeviceToken(row.token);
        }
      }
      return;
    }
  }

  // No device_tokens rows (or no userId) → fall back to the passed Expo token.
  if (!expoPushToken) return;
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
