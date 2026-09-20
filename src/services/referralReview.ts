// Referral-review predicate (Phase 36). Decides whether a referrer's code keeps
// attribution but must NOT bypass the access-review gate (Phase 34/35).
//
// The list of review-required referrer user IDs lives in an env var, keyed on
// users.id (not handle — handles can change). An empty set means the feature is
// fully off and every code path behaves exactly as it did before this phase
// (D-01, D-10).
//
// This module deliberately imports nothing — not ../db, not drizzle-orm, not
// the logger — so it stays runnable under a standalone `tsx -e` check and can
// never drag a database connection into a unit check.

export const REFERRAL_REVIEW_ENV_VAR = 'REFERRAL_REVIEW_REQUIRED_USER_IDS';

/**
 * Parse a comma-separated list of user IDs. Whitespace-tolerant; blank,
 * non-numeric, zero, and negative tokens are silently discarded, so a malformed
 * value degrades to "feature off" rather than crashing or partially enabling.
 */
export function parseReviewRequiredUserIds(raw: string | undefined): Set<number> {
  const ids = new Set<number>();
  if (!raw) return ids;
  for (const token of raw.split(',')) {
    const trimmed = token.trim();
    if (!/^\d+$/.test(trimmed)) continue;
    const id = Number.parseInt(trimmed, 10);
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  return ids;
}

/**
 * True when this referrer's code must go through access review. Reads the env
 * var on every call (D-01) so no code path memoizes a boot-time value.
 */
export function isReviewRequiredReferrer(userId: number): boolean {
  return parseReviewRequiredUserIds(process.env[REFERRAL_REVIEW_ENV_VAR]).has(userId);
}
