/**
 * Expo Push Notification Service
 * Sends push notifications via Expo's push gateway (free, no Firebase required).
 */

interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
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
    console.error('[push] Failed to send push notifications', err);
    return [];
  }
}

export async function sendPushToUser(
  expoPushToken: string | null | undefined,
  title: string,
  body: string,
  data?: Record<string, unknown>
): Promise<void> {
  if (!expoPushToken) return;

  await sendPushNotifications([
    {
      to: expoPushToken,
      title,
      body,
      data,
      sound: 'default',
      channelId: 'default',
    },
  ]);
}
