/**
 * Numeric-limit helpers for capability enforcement.
 *
 * Provides:
 *   - countActiveBeacons(userId)   — SQL count() against `beacons` filtered by
 *                                    userId + isActive=true. Mirrors the
 *                                    existing query in routes/beacons.ts:39-42
 *                                    so Plan 03-03's retrofit produces
 *                                    identical numeric outcomes for the same
 *                                    DB state.
 *   - countOwnedGroups(userId)     — SQL count() against
 *                                    `conversation_participants` joined to
 *                                    `conversations`, filtered to admin role
 *                                    + isGroup=true + leftAt IS NULL. Defined
 *                                    now even though Phase 3 has no consumer
 *                                    — Phase 4 will use it (D-06 explicit).
 *   - enforceLimit(req, key, fn)   — Reads caps via getCapabilities(req)
 *                                    (Plan 03-01 — D-02 memoizer), runs the
 *                                    counter against req.user!.id, compares
 *                                    against caps.limits[limitKey], and on
 *                                    over-limit calls logCapabilityDenial
 *                                    (reason: 'limit') then throws
 *                                    CapabilityViolationError. The route
 *                                    handler converts that throw into a 403.
 *
 * Capability-driven only: this module never reads `req.user!.isPremium`.
 * The legacy isPremium gate inside beacons.ts will be replaced by Plan 03-03.
 *
 * Satisfies ENFORCE-03 (numeric limits read current DB count, compare against
 * caps.limits.*) and completes ENFORCE-04 (limit denials route through the
 * same structured-log helper as feature denials — D-10).
 */
import { and, count, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { beacons, conversations, conversationParticipants } from '../db/schema';
import type { AuthRequest } from '../middleware/auth';
import type { Capabilities } from '../types/capabilities';
import { getCapabilities, CapabilityViolationError } from '../middleware/capabilities';
import { logCapabilityDenial } from '../lib/capabilityLogger';

// ── Count helpers ─────────────────────────────────────────────────────────

/**
 * Count active beacons owned by the given user.
 *
 * Mirrors the existing query in routes/beacons.ts:39-42 verbatim
 * (`userId = $userId AND isActive = true`) so Plan 03-03's retrofit is a
 * 1:1 numeric replacement for the legacy isPremium-gated branch.
 */
export async function countActiveBeacons(userId: number): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(beacons)
    .where(and(eq(beacons.userId, userId), eq(beacons.isActive, true)));
  return Number(row?.value ?? 0);
}

/**
 * Count groups (group conversations) owned by the given user.
 *
 * "Owned" semantics: the user holds an active admin participant row on a
 * group-flagged conversation. Mirrors the membership semantics already used
 * by routes/groups.ts (creator gets role='admin' at creation time).
 *
 * Exported even though Phase 3 has no consumer — Phase 4 will (D-06).
 * Defining it here keeps Phase 4 from re-deciding the SQL shape.
 */
export async function countOwnedGroups(userId: number): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(conversationParticipants)
    .innerJoin(conversations, eq(conversations.id, conversationParticipants.conversationId))
    .where(
      and(
        eq(conversationParticipants.userId, userId),
        eq(conversationParticipants.role, 'admin'),
        eq(conversations.isGroup, true),
        isNull(conversationParticipants.leftAt),
      ),
    );
  return Number(row?.value ?? 0);
}

// ── enforceLimit ──────────────────────────────────────────────────────────

/**
 * Enforce a numeric capability limit at the top of a route handler.
 *
 * Reads caps via getCapabilities(req) (Plan 03-01 D-02 — memoized per-request,
 * so a route that also runs requireCapability(...) middleware doesn't re-fetch),
 * runs the counter against the authenticated userId, and compares.
 *
 * On over-limit, emits the canonical denial log via logCapabilityDenial with
 * `reason: 'limit'` plus current/max (D-10), then throws
 * CapabilityViolationError. The route handler is expected to wrap the call:
 *
 *   try {
 *     await enforceLimit(req, 'maxBeacons', countActiveBeacons);
 *   } catch (err) {
 *     if (err instanceof CapabilityViolationError) {
 *       res.status(403).json({ error: '...', capabilityViolation: true, ... });
 *       return;
 *     }
 *     throw err;
 *   }
 *
 * `limitKey` is typed `keyof Capabilities['limits']` so a typo at the call
 * site is a TS error (D-06 type-safety note).
 *
 * The default error message is the literal `'Limit reached'` — the route
 * handler controls user-facing copy when constructing the 403 from the caught
 * error (D-07: layered shape, route owns specific wording).
 */
export async function enforceLimit(
  req: AuthRequest,
  limitKey: keyof Capabilities['limits'],
  counter: (userId: number) => Promise<number>,
): Promise<void> {
  const caps = await getCapabilities(req);
  const max = caps.limits[limitKey];
  const current = await counter(req.user!.id);
  if (current >= max) {
    logCapabilityDenial({
      req,
      capability: limitKey,
      currentTier: caps.tier,
      reason: 'limit',
      current,
      max,
    });
    throw new CapabilityViolationError({
      capability: limitKey,
      tier: caps.tier,
      message: 'Limit reached',
      current,
      max,
    });
  }
}
