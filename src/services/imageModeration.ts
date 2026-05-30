import OpenAI from 'openai';
import logger from '../lib/logger';
import { deleteObject, cdnUrlToKey } from './storage';

const log = logger.child({ module: 'moderation' });
import { db } from '../db';
import { messages, notifications, userProfiles, conversations } from '../db/schema';
import { eq } from 'drizzle-orm';
import { Server } from 'socket.io';
import { sendPushToUser } from './pushNotifications';

// ── Image Moderation Service ───────────────────────────────────────────────
// Two-pass image moderation: OpenAI Moderation API (fast) + GPT-4o Vision (community-specific).
// Abstraction layer allows easy model swapping per PROJECT.md decision.

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export interface ImageModerationResult {
  isAllowed: boolean;
  category?: string;
  confidence?: number;
}

// ── Category humanizer ─────────────────────────────────────────────────────

const CATEGORY_MAP: Record<string, string> = {
  'sexual': 'Sexual content',
  'sexual/minors': 'Sexual content involving minors',
  'violence': 'Violence',
  'violence/graphic': 'Graphic violence',
  'self-harm': 'Self-harm',
  'self-harm/intent': 'Self-harm intent',
  'self-harm/instructions': 'Self-harm instructions',
  'harassment': 'Harassment',
  'harassment/threatening': 'Threatening harassment',
  'hate': 'Hate speech',
  'hate/threatening': 'Threatening hate speech',
  'illicit': 'Illicit content',
  'illicit/violent': 'Illicit violent content',
};

function humanizeCategory(category: string): string {
  return CATEGORY_MAP[category] ?? category.replace(/[/_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Two-pass image moderation for a single image URL.
 * Pass 1: OpenAI Moderation API (omni-moderation-latest) — fast, general.
 * Pass 2: GPT-4o Vision — community-specific (antisemitism, hate symbols, etc.).
 */
export async function moderateImage(imageUrl: string): Promise<ImageModerationResult> {
  try {
    // ── Pass 1: OpenAI Moderation API ──────────────────────────────────────
    const moderation = await client.moderations.create({
      model: 'omni-moderation-latest',
      input: [{ type: 'image_url', image_url: { url: imageUrl } }],
    });

    const result = moderation.results[0];
    if (result.flagged) {
      const flaggedEntry = Object.entries(result.categories).find(([_, v]) => v);
      const category = flaggedEntry ? humanizeCategory(flaggedEntry[0]) : 'Policy violation';
      return { isAllowed: false, category };
    }

    // ── Pass 2: GPT-4o Vision (community-specific) ────────────────────────
    const visionResponse = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `You are a content moderator for TribeLife, a Jewish community app connecting Jews worldwide.

Analyze this image for content that violates our community guidelines. Check specifically for:
1. Hate symbols (swastikas, SS bolts, white supremacist symbols)
2. Antisemitic imagery (Holocaust denial, Jewish caricatures, blood libel imagery)
3. Anti-Zionist propaganda (maps erasing Israel, terrorist group logos like Hamas/Hezbollah)
4. Spam or scam content (QR codes, phishing, promotional spam)
5. Generally offensive content (explicit nudity, gore, drug use)

Respond with valid JSON only (no markdown, no explanation):
{
  "isAllowed": boolean,
  "category": string | null,
  "confidence": number
}

Categories for rejection: "Hate symbols", "Antisemitism", "Anti-Zionist content", "Spam/scam", "Offensive content"
If the image is acceptable, return: { "isAllowed": true, "category": null, "confidence": 0.95 }`,
            },
            {
              type: 'image_url',
              image_url: { url: imageUrl },
            },
          ],
        },
      ],
    });

    const rawContent = visionResponse.choices[0]?.message?.content ?? '{}';
    // Strip markdown code fences if present (GPT-4o often wraps JSON in ```json ... ```)
    const raw = rawContent.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

    try {
      const parsed = JSON.parse(raw) as ImageModerationResult;
      return {
        isAllowed: parsed.isAllowed ?? false,
        category: parsed.category ?? undefined,
        confidence: parsed.confidence ?? undefined,
      };
    } catch {
      // Parse failure — fail closed
      return { isAllowed: false, category: 'Unable to analyze image' };
    }
  } catch (err) {
    log.error({ err }, 'Image analysis failed');
    return { isAllowed: false, category: 'Moderation service error' };
  }
}

/**
 * Moderate all images in a message. Runs async (fire-and-forget from socket handlers).
 * Deletes flagged images from storage, updates DB, emits socket events.
 */
export async function moderateMessageImages(
  messageId: number,
  mediaUrls: string[],
  senderId: number,
  io: Server,
  roomId: string
): Promise<void> {
  const results = await Promise.all(
    mediaUrls.map(async (url) => ({
      url,
      result: await moderateImage(url),
    }))
  );

  const flagged = results.filter((r) => !r.result.isAllowed);
  if (flagged.length === 0) return;

  const flaggedUrls = flagged.map((f) => f.url);

  // Delete flagged images from storage
  for (const url of flaggedUrls) {
    const key = cdnUrlToKey(url);
    if (key) {
      await deleteObject(key);
    }
  }

  // Update message in DB — remove flagged URLs
  const [msg] = await db
    .select({ mediaUrls: messages.mediaUrls })
    .from(messages)
    .where(eq(messages.id, messageId));

  const currentUrls = (msg?.mediaUrls as string[]) ?? [];
  const remaining = currentUrls.filter((u) => !flaggedUrls.includes(u));

  await db
    .update(messages)
    .set({ mediaUrls: remaining.length > 0 ? remaining : null })
    .where(eq(messages.id, messageId));

  // Emit removal event to all users in the room
  io.to(roomId).emit('message:media_removed', {
    messageId,
    removedUrls: flaggedUrls,
    remainingUrls: remaining,
  });

  // Emit rejection event to sender only
  const category = flagged[0].result.category ?? 'Policy violation';
  io.to(`user:${senderId}`).emit('message:media_rejected', {
    messageId,
    category,
    message: `Image removed: ${category}. See our community guidelines: tribelife.app/terms`,
  });

  // ── System notification + always-on push to the uploader ─────────────────
  // Inserts a type:'system' bell row for the uploader only naming the chat.
  // Push is always-on (bypasses shouldSendPush — account/content notice).
  // Failure here must NOT abort the media_rejected emit above.
  try {
    // Derive a human-readable chat name from the roomId prefix.
    let chatName: string;
    if (roomId.startsWith('timezone:')) {
      chatName = roomId.slice('timezone:'.length);
    } else if (roomId.startsWith('globe:')) {
      chatName = roomId.slice('globe:'.length);
    } else if (roomId.startsWith('conversation:')) {
      // Attempt a cheap group-name lookup; fall back to "your conversation".
      const convIdStr = roomId.slice('conversation:'.length);
      const convId = parseInt(convIdStr, 10);
      if (!Number.isNaN(convId)) {
        const [conv] = await db
          .select({ groupName: conversations.groupName })
          .from(conversations)
          .where(eq(conversations.id, convId))
          .limit(1);
        chatName = conv?.groupName ?? 'your conversation';
      } else {
        chatName = 'your conversation';
      }
    } else {
      chatName = roomId;
    }

    const title = 'Image removed';
    const body = `Your image in ${chatName} was removed: ${category}`;
    const notifData = { source: 'system', kind: 'moderation', roomId, messageId };

    // Insert the System notification row.
    const [inserted] = await db
      .insert(notifications)
      .values({ userId: senderId, type: 'system', title, body, data: notifData })
      .returning({ id: notifications.id });

    // Fetch the uploader's push token.
    const [profile] = await db
      .select({ expoPushToken: userProfiles.expoPushToken })
      .from(userProfiles)
      .where(eq(userProfiles.userId, senderId))
      .limit(1);

    // Always-on push — bypass shouldSendPush (moderation is an account notice).
    if (profile?.expoPushToken) {
      await sendPushToUser(
        profile.expoPushToken,
        title,
        body,
        notifData,
        senderId,
      );
    }

    // Real-time bell update for foregrounded clients.
    io.to(`user:${senderId}`).emit('notification:new', {
      id: inserted?.id,
      type: 'system',
      title,
      body,
      data: notifData,
      isRead: false,
    });
  } catch (err) {
    log.error({ err, messageId, senderId }, '[moderation-notice] failed to send System notification');
  }

  log.info({ messageId, count: flaggedUrls.length }, 'Removed flagged images from message');
}
