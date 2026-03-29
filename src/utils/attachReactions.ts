import { inArray } from 'drizzle-orm';
import { db } from '../db';
import { reactions } from '../db/schema';

/**
 * Attach grouped reaction data to an array of message rows.
 * Each message gets a `reactions` array with { emoji, count, userIds, hasReacted }.
 */
export async function attachReactions<T extends { id: number }>(
  messageRows: T[],
  currentUserId: number,
): Promise<(T & { reactions: { emoji: string; count: number; userIds: number[]; hasReacted: boolean }[] })[]> {
  if (messageRows.length === 0) return messageRows.map(m => ({ ...m, reactions: [] }));

  const messageIds = messageRows.map(m => m.id);
  const reactionRows = await db
    .select({
      messageId: reactions.messageId,
      emoji: reactions.emoji,
      userId: reactions.userId,
    })
    .from(reactions)
    .where(inArray(reactions.messageId, messageIds));

  // Group by messageId then by emoji
  const grouped: Record<number, Record<string, { count: number; userIds: number[]; hasReacted: boolean }>> = {};
  for (const r of reactionRows) {
    if (!grouped[r.messageId]) grouped[r.messageId] = {};
    if (!grouped[r.messageId][r.emoji]) grouped[r.messageId][r.emoji] = { count: 0, userIds: [], hasReacted: false };
    grouped[r.messageId][r.emoji].count++;
    grouped[r.messageId][r.emoji].userIds.push(r.userId);
    if (r.userId === currentUserId) grouped[r.messageId][r.emoji].hasReacted = true;
  }

  return messageRows.map(msg => ({
    ...msg,
    reactions: Object.entries(grouped[msg.id] ?? {}).map(([emoji, data]) => ({
      emoji,
      count: data.count,
      userIds: data.userIds,
      hasReacted: data.hasReacted,
    })),
  }));
}
