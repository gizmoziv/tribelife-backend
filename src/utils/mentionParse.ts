// Phase 38.1 D-00b: pure mention-parsing helpers. NO runtime import of db/schema/drizzle —
// only a type-only import so this module can be exercised offline (no DB connection).
import type { OrderedMention } from '../db/schema';

export const MENTION_HANDLE_REGEX = /@([a-zA-Z0-9_]+)/g;

// Returns every @handle occurrence in `content`, lowercased, in text order,
// preserving duplicates. Does not deduplicate or sort.
export function parseMentionHandles(content: string): string[] {
  const regex = new RegExp(MENTION_HANDLE_REGEX.source, 'g');
  const handles: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    handles.push(match[1].toLowerCase());
  }
  return handles;
}

// Maps EVERY input handle (in order, including duplicates) to its resolved
// userId via the lookup map, or null when the handle didn't resolve to a
// real user. Does not filter or collapse — output.length === handles.length.
export function buildOrderedMentions(
  handles: string[],
  handleToUserId: ReadonlyMap<string, number>,
): OrderedMention[] {
  return handles.map((handle) => ({
    handle,
    userId: handleToUserId.get(handle) ?? null,
  }));
}
