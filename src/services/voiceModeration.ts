import { db } from '../db';
import { messages, notifications, userProfiles, conversations } from '../db/schema';
import { eq } from 'drizzle-orm';
import { Server } from 'socket.io';
import { deleteObject, cdnUrlToKey } from './storage';
import { sendPushToUser } from './pushNotifications';
import { transcribeWithRetry, moderateTranscript } from './voiceTranscription';
import logger from '../lib/logger';

const log = logger.child({ module: 'voice-moderation' });

// ── Voice Moderation Service ───────────────────────────────────────────────────
// Fire-and-forget entry point called by socket handlers (Plan 04) after the
// voice message has been optimistically broadcast. Mirrors moderateMessageImages()
// from imageModeration.ts: transcribe → moderate → on rejection/failure:
//   delete audio from Spaces, null voiceUrl column, emit room-wide voice_removed
//   + sender-only voice_rejected, insert system notification, always-on push.
// This function NEVER throws to the caller (top-level catch logs and returns).

/**
 * Async voice message moderation — fire-and-forget from socket handlers.
 * @param messageId - DB id of the already-inserted message row
 * @param audioUrl  - public CDN URL of the uploaded voice audio
 * @param senderId  - userId of the message sender
 * @param io        - Socket.IO server instance for event emission
 * @param roomId    - Socket.IO room key the message was broadcast to
 *                    (e.g. 'timezone:<tz>', 'globe:<slug>', 'conversation:<id>').
 *                    Plan 04 is responsible for passing the correct broadcast key.
 */
export async function moderateVoiceMessage(
  messageId: number,
  audioUrl: string,
  senderId: number,
  io: Server,
  roomId: string,
): Promise<void> {
  let failureReason: string | undefined;

  try {
    // ── Step 1: Fetch audio from CDN into a Buffer ──────────────────────────
    const res = await fetch(audioUrl);
    if (!res.ok) {
      throw new Error(`Failed to fetch audio from CDN: ${res.status} ${res.statusText}`);
    }
    const audioBuffer = Buffer.from(await res.arrayBuffer());

    // ── Step 2: Transcribe with retry (D-07/D-08) ───────────────────────────
    const transcript = await transcribeWithRetry(audioBuffer);

    // ── Step 3: D-06 — empty transcript is allowed through ──────────────────
    // Legitimate non-speech audio (music, ambient sound, silence) returns an
    // empty or whitespace-only transcript. Allow through without removal.
    if (transcript.trim().length === 0) {
      log.info({ messageId }, '[voice-moderation] empty transcript — allowing through (D-06)');
      return;
    }

    // ── Step 4: Two-pass moderation (D-04/D-05) ─────────────────────────────
    const modResult = await moderateTranscript(transcript);

    if (modResult.isAllowed) {
      // Save transcript for instant reveal on playback (VOICE-13 cached reveal)
      await db
        .update(messages)
        .set({ voiceTranscript: transcript })
        .where(eq(messages.id, messageId));

      log.info({ messageId }, '[voice-moderation] transcript saved — voice message allowed');
      return;
    }

    // Moderation flagged the transcript
    failureReason = modResult.category ?? 'Policy violation';
    log.info(
      { messageId, reason: failureReason },
      '[voice-moderation] transcript flagged — entering fail-closed path',
    );
  } catch (err) {
    // Permanent transcription failure (permanent error after retry exhausted, D-08 / VOICE-09)
    log.error(
      { err, messageId },
      '[voice-moderation] transcription/moderation failed — failing closed (D-08)',
    );
    failureReason = 'Transcription failed';
  }

  // ── Fail-closed removal path ───────────────────────────────────────────────
  // Mirrors moderateMessageImages() removal path exactly.
  // Runs on: moderation rejection OR permanent transcription failure.

  // Delete audio object from DO Spaces (D-09)
  const key = cdnUrlToKey(audioUrl);
  if (key) {
    await deleteObject(key);
  }

  // Null out the voiceUrl column so clients can no longer attempt playback
  await db
    .update(messages)
    .set({ voiceUrl: null })
    .where(eq(messages.id, messageId));

  // Room-wide removal event — Plan 04 passes the correct broadcast room key
  io.to(roomId).emit('message:voice_removed', { messageId });

  // Sender-only rejection notice
  io.to(`user:${senderId}`).emit('message:voice_rejected', {
    messageId,
    category: failureReason,
    message: `Voice message removed: ${failureReason}. See our community guidelines: tribelife.app/terms`,
  });

  // ── System notification + always-on push ───────────────────────────────────
  // Mirrors imageModeration.ts lines 202-270.
  // Wrapped in try/catch so notification failure never aborts the removal emits above.
  try {
    // Derive a human-readable chat name from the roomId prefix
    let chatName: string;
    if (roomId.startsWith('timezone:')) {
      chatName = roomId.slice('timezone:'.length);
    } else if (roomId.startsWith('globe:')) {
      chatName = roomId.slice('globe:'.length);
    } else if (roomId.startsWith('conversation:')) {
      // Attempt a cheap group-name lookup; fall back to "your conversation"
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

    const title = 'Voice message removed';
    const body = `Your voice message in ${chatName} was removed: ${failureReason}`;
    const notifData: Record<string, unknown> = {
      source: 'system',
      kind: 'moderation',
      roomId,
      messageId,
    };

    // Insert the system notification row
    const [inserted] = await db
      .insert(notifications)
      .values({ userId: senderId, type: 'system', title, body, data: notifData })
      .returning({ id: notifications.id });

    // Fetch the sender's push token
    const [profile] = await db
      .select({ expoPushToken: userProfiles.expoPushToken })
      .from(userProfiles)
      .where(eq(userProfiles.userId, senderId))
      .limit(1);

    // Always-on push — bypasses shouldSendPush (account/content notice per D-03)
    if (profile?.expoPushToken) {
      await sendPushToUser(profile.expoPushToken, title, body, notifData, senderId);
    }

    // Real-time bell update for foregrounded clients
    io.to(`user:${senderId}`).emit('notification:new', {
      id: inserted?.id,
      type: 'system',
      title,
      body,
      data: notifData,
      isRead: false,
    });
  } catch (err) {
    log.error(
      { err, messageId, senderId },
      '[voice-moderation] failed to send system notification',
    );
  }

  log.info({ messageId, reason: failureReason }, '[voice-moderation] voice message removed');
}
