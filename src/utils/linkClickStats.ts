// Pure counting and write rules for link-click analytics (quick 261003-nfu).
//
// The routes in routes/linkClicks.ts follow these rules. They live here, with
// zero imports, so scripts/verify-link-analytics.mjs can test them without a
// database.

// ── Constants ────────────────────────────────────────────────────────────────

// A repeat tap on the same link by the same user inside this window is dropped.
export const LINK_CLICK_DEDUPE_MS = 2000;
// Upper bound on stored clicks per user per message (all links together).
export const LINK_CLICK_MAX_PER_USER_PER_MESSAGE = 50;

export const LINK_CLICK_SOURCES = ['text', 'preview', 'youtube'] as const;
export const LINK_CLICK_PLATFORMS = ['ios', 'android'] as const;
export type LinkClickSource = (typeof LINK_CLICK_SOURCES)[number];
export type LinkClickPlatform = (typeof LINK_CLICK_PLATFORMS)[number];

// ── Types ────────────────────────────────────────────────────────────────────

export type LinkClickWriteDecision = 'record' | 'sender' | 'capped' | 'duplicate';
export type PerUserLinkClicks = { url: string; userId: number; clicks: number };
export type LinkClickStat = { url: string; clicks: number; uniqueClickers: number };

// ── Rules ────────────────────────────────────────────────────────────────────

// The SINGLE choke point for "user-created group". The schema has no org-owned
// or broadcast conversation type, so is_group = true is exactly the groups
// created through POST /api/groups. A future org-group type must add a
// discriminator and update this predicate.
export function isLinkAnalyticsConversation(
  conversation: { isGroup: boolean | null } | null | undefined,
): boolean {
  return conversation?.isGroup === true;
}

// Precedence: the sender's own click, then the per-user cap, then the dedupe.
export function decideLinkClickWrite(input: {
  isSender: boolean;
  priorClicks: number;
  hasRecentSameUrlClick: boolean;
}): LinkClickWriteDecision {
  if (input.isSender) return 'sender';
  if (input.priorClicks >= LINK_CLICK_MAX_PER_USER_PER_MESSAGE) return 'capped';
  if (input.hasRecentSameUrlClick) return 'duplicate';
  return 'record';
}

export function linkClickDedupeCutoff(now: Date): Date {
  return new Date(now.getTime() - LINK_CLICK_DEDUPE_MS);
}

function cleanCount(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

// Rows are one per (url, user) with that user's click count. Returns one entry
// per distinct key, in key order, zero-click keys included. clicks is the sum,
// uniqueClickers the number of distinct users. The sender's own rows are
// skipped (no exclusion when senderId is null).
export function aggregateLinkClicks(
  linkKeys: string[],
  rows: PerUserLinkClicks[],
  senderId: number | null,
): LinkClickStat[] {
  const keys: string[] = [];
  const seenKeys = new Set<string>();
  for (const key of linkKeys) {
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    keys.push(key);
  }
  const clicks = new Map<string, number>();
  const users = new Map<string, Set<number>>();
  for (const key of keys) {
    clicks.set(key, 0);
    users.set(key, new Set<number>());
  }
  for (const row of rows) {
    if (!seenKeys.has(row.url)) continue;
    if (senderId !== null && row.userId === senderId) continue;
    const n = cleanCount(row.clicks);
    if (n === 0) continue;
    clicks.set(row.url, (clicks.get(row.url) ?? 0) + n);
    users.get(row.url)?.add(row.userId);
  }
  return keys.map((url) => ({
    url,
    clicks: clicks.get(url) ?? 0,
    uniqueClickers: users.get(url)?.size ?? 0,
  }));
}

// True only for pg's `relation "<relation>" does not exist` (code 42P01),
// optionally schema-qualified, found on the error or up to 3 levels down its
// `cause` chain (Drizzle wraps pg errors). A missing OTHER relation returns
// false so it surfaces as a real error.
export function isMissingRelationError(err: unknown, relation: string): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth++) {
    const e = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (
      e.code === '42P01' &&
      typeof e.message === 'string' &&
      (e.message.includes(`"${relation}"`) || e.message.includes(`.${relation}"`))
    ) {
      return true;
    }
    current = e.cause;
  }
  return false;
}
