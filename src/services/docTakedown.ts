import { Server } from 'socket.io';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { messages } from '../db/schema';
import { quarantineObject, cdnUrlToKey } from './storage';
import { logModerationEvent } from '../lib/moderationLog';
import logger from '../lib/logger';

const log = logger.child({ module: 'moderation' });

// ── Reactive document (PDF) takedown ────────────────────────────────────────
// PDFs ship unmoderated (operator-locked, D-06) — this is the ONLY safety
// lever: a reported message's attachments can be pulled by calling this
// service (from the report path / a future admin endpoint / a one-off human
// script). This is NEVER invoked from the send/upload path. Mirrors the
// quarantine + DB-null + message:media_removed mechanics that
// imageModeration.moderateMessageImages uses for images, but for
// messages.attachments.

/**
 * Quarantine every PDF attachment on a message, null the `attachments`
 * column, and (when a socket server is supplied) emit `message:media_removed`
 * so foregrounded clients drop the document card live. `io` is optional so a
 * human takedown script can call this without a running socket server.
 */
export async function quarantineMessageDocuments(
  messageId: number,
  io?: Server
): Promise<{ quarantined: number }> {
  const [msg] = await db
    .select({
      attachments: messages.attachments,
      roomId: messages.roomId,
      conversationId: messages.conversationId,
      senderId: messages.senderId,
    })
    .from(messages)
    .where(eq(messages.id, messageId));

  const attachments = msg?.attachments ?? [];
  if (attachments.length === 0) return { quarantined: 0 };

  // senderId is nullable on messages (onDelete: 'set null'); ModerationLogFields
  // requires a number, so fall back to 0 for the rare orphaned-sender case.
  const senderId = msg!.senderId ?? 0;

  const removedUrls: string[] = [];
  let quarantined = 0;

  for (const att of attachments) {
    const key = cdnUrlToKey(att.url);
    let quarantineKey: string | undefined;

    if (key) {
      const q = await quarantineObject(key);
      quarantineKey = q?.quarantineKey;
      if (quarantineKey) quarantined += 1;
    }

    removedUrls.push(att.url);

    logModerationEvent({
      surface: 'document',
      action: 'quarantined',
      mediaUrl: att.url,
      quarantineKey,
      messageId,
      senderId,
      roomId: msg!.roomId ?? undefined,
    });
  }

  // Null the column so the document card disappears for everyone — mirrors
  // imageModeration nulling mediaUrls.
  await db
    .update(messages)
    .set({ attachments: null })
    .where(eq(messages.id, messageId));

  if (io) {
    const roomKey = msg!.roomId ?? `conversation:${msg!.conversationId}`;
    io.to(roomKey).emit('message:media_removed', {
      messageId,
      removedUrls,
      remainingUrls: [],
    });
  }

  log.info({ messageId, count: removedUrls.length }, 'Quarantined document attachments from message');

  return { quarantined };
}
