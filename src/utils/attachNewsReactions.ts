import { inArray } from 'drizzle-orm';
import { db } from '../db';
import { newsReactions } from '../db/schema';

/**
 * Attach grouped reaction data to an array of news article rows.
 * Each article gets a `reactions` array with { emoji, count, userIds, hasReacted }.
 *
 * Cloned from attachReactions.ts — queries newsReactions instead of reactions.
 * Clone (not generified) per PATTERNS §3: Drizzle column refs are not plain strings;
 * generification would require Column<any> gymnastics — risk/reward is negative.
 *
 * Implements REACT-03 server-side aggregation. Batch query (one round-trip for all
 * article ids) — no N+1 per Pattern 3 batch rule.
 */
export interface NewsReactionGroup {
  emoji: string;
  count: number;
  userIds: number[];
  hasReacted: boolean;
}

export async function attachNewsReactions<T extends { id: number }>(
  rows: T[],
  currentUserId: number,
): Promise<(T & { reactions: NewsReactionGroup[] })[]> {
  // Zero-row fast path — no DB query needed
  if (rows.length === 0) return rows.map(r => ({ ...r, reactions: [] }));

  const ids = rows.map(r => r.id);
  const reactionRows = await db
    .select({
      articleId: newsReactions.articleId,
      emoji: newsReactions.emoji,
      userId: newsReactions.userId,
    })
    .from(newsReactions)
    .where(inArray(newsReactions.articleId, ids));

  // Group by articleId then by emoji
  const grouped: Record<number, Record<string, { count: number; userIds: number[]; hasReacted: boolean }>> = {};
  for (const r of reactionRows) {
    (grouped[r.articleId] ??= {});
    (grouped[r.articleId][r.emoji] ??= { count: 0, userIds: [], hasReacted: false });
    grouped[r.articleId][r.emoji].count++;
    grouped[r.articleId][r.emoji].userIds.push(r.userId);
    if (r.userId === currentUserId) grouped[r.articleId][r.emoji].hasReacted = true;
  }

  return rows.map(r => ({
    ...r,
    reactions: Object.entries(grouped[r.id] ?? {}).map(([emoji, data]) => ({ emoji, ...data })),
  }));
}
