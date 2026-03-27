import { inArray, eq } from 'drizzle-orm';
import { db } from '../db';
import { messages, userProfiles } from '../db/schema';

/**
 * Attach replyTo preview data to an array of message rows.
 * Each message gets a `replyTo: { id, content, senderHandle } | null`.
 */
export async function attachReplyTo<T extends { id: number }>(
  messageRows: T[],
): Promise<(T & { replyTo: { id: number; content: string; senderHandle: string } | null })[]> {
  if (messageRows.length === 0) return messageRows.map(m => ({ ...m, replyTo: null }));

  // First, get the replyToId for each message
  const messageIds = messageRows.map(m => m.id);
  const replyRows = await db
    .select({
      id: messages.id,
      replyToId: messages.replyToId,
    })
    .from(messages)
    .where(inArray(messages.id, messageIds));

  const replyToIdMap: Record<number, number> = {};
  const replyToIds: number[] = [];
  for (const r of replyRows) {
    if (r.replyToId) {
      replyToIdMap[r.id] = r.replyToId;
      if (!replyToIds.includes(r.replyToId)) replyToIds.push(r.replyToId);
    }
  }

  if (replyToIds.length === 0) return messageRows.map(m => ({ ...m, replyTo: null }));

  // Fetch the original messages with sender handle
  const originals = await db
    .select({
      id: messages.id,
      content: messages.content,
      senderHandle: userProfiles.handle,
    })
    .from(messages)
    .leftJoin(userProfiles, eq(userProfiles.userId, messages.senderId))
    .where(inArray(messages.id, replyToIds));

  const originalMap: Record<number, { id: number; content: string; senderHandle: string }> = {};
  for (const o of originals) {
    originalMap[o.id] = {
      id: o.id,
      content: o.content ?? '',
      senderHandle: o.senderHandle ?? 'Unknown',
    };
  }

  return messageRows.map(msg => ({
    ...msg,
    replyTo: replyToIdMap[msg.id] ? (originalMap[replyToIdMap[msg.id]] ?? null) : null,
  }));
}
