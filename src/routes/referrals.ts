import { Router, Response } from 'express';
import { z } from 'zod';
import { db } from '../db';
import { referrals, attributionConversions, users, userProfiles } from '../db/schema';
import { eq, count, sql } from 'drizzle-orm';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

// ── Get referral stats for current user ──────────────────────────────────
router.get('/stats', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;

  const [result] = await db
    .select({ total: count() })
    .from(referrals)
    .where(eq(referrals.referrerId, userId));

  const totalReferrals = result?.total ?? 0;
  const premiumMonthsEarned = Math.min(totalReferrals, 12);

  res.json({
    totalReferrals,
    premiumMonthsEarned,
  });
});

// ── Get per-source referral funnel for current user (Phase 13) ───────────
// Self-view only — query is hardcoded against req.user!.id; NEVER accepts a
// user-id query param. See plan 13-06 threat T-13-06-01 + ASVS L1 V4.1.
//
// Two display buckets: `group_invite` (referrals via a group), and
// `profile_share` = EVERY other (non-group) source — handle_code,
// profile_share, manual_entry, and any future non-group source. Bucketing this
// way (rather than a hardcoded allow-list) means the two rows always reconcile
// with the total-referrals / free-months figure on the profile page, and no
// source can be silently dropped again the way manual_entry was.
type FunnelBucket = 'profile_share' | 'group_invite';
const bucketOf = (source: string | null): FunnelBucket =>
  source === 'group_invite' ? 'group_invite' : 'profile_share';

router.get('/funnel', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;

  // Signup counts per source (referrals table, locked at onboarding).
  const signupRows = await db
    .select({ source: referrals.source, total: count() })
    .from(referrals)
    .where(eq(referrals.referrerId, userId))
    .groupBy(referrals.source);

  // Paid-conversion counts per source. COUNT(DISTINCT referred_user_id)
  // dedupes users whose subscription cancel + resubscribe fires
  // INITIAL_PURCHASE twice (CONTEXT.md "Multi-conversion tracking per user").
  const paidRows = await db
    .select({
      source: attributionConversions.source,
      total: sql<number>`COUNT(DISTINCT ${attributionConversions.referredUserId})`,
    })
    .from(attributionConversions)
    .where(eq(attributionConversions.referrerUserId, userId))
    .groupBy(attributionConversions.source);

  const bySource: Record<FunnelBucket, { joined: number; paid: number }> = {
    profile_share: { joined: 0, paid: 0 },
    group_invite: { joined: 0, paid: 0 },
  };
  for (const row of signupRows) {
    bySource[bucketOf(row.source)].joined += Number(row.total);
  }
  for (const row of paidRows) {
    bySource[bucketOf(row.source)].paid += Number(row.total);
  }

  const totalReferrals =
    bySource.profile_share.joined + bySource.group_invite.joined;
  const totalPremiumMonths = Math.min(totalReferrals, 12);

  res.json({ bySource, totalPremiumMonths });
});

// ── D-05: durable server-side referral-attempt cap ────────────────────────
export const REFERRAL_MAX_ATTEMPTS = 3;

// Deliberately no .min(1) — a blank handle is a valid request that takes the
// D-10 zero-attempts branch below, not a 400.
const referralValidateSchema = z.object({ handle: z.string() });

// ── Live-validate a referral handle, separate from the final onboarding
// submit (D-04 — this handler never inserts into `referrals`). D-06: the
// uniform 200 body below is built through exactly ONE shared res.json(...)
// call fed by locally computed valid/exhausted/attemptsRemaining/blank — that
// uniformity IS the anti-enumeration control. Do not add cause-specific
// messages or status codes here; a future "helpful" branch would leak handle
// existence through the response shape alone.
router.post('/validate', async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = referralValidateSchema.safeParse(req.body);
  if (!parse.success) {
    // Request-shape error, not a handle-existence signal — 400 here does not
    // violate D-06.
    res.status(400);
    res.json({ error: parse.error.errors[0].message });
    return;
  }
  const { handle } = parse.data;
  const userId = req.user!.id;

  // D-05: read the durable counter only from user_profiles.referral_attempts,
  // never from the request payload — the cap must hold against a caller
  // hitting the API directly with no mobile client involved.
  const [row] = await db
    .select({ referralAttempts: userProfiles.referralAttempts })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  const attempts = row?.referralAttempts ?? 0;

  const trimmed = handle.trim();

  let valid: boolean;
  let exhausted: boolean;
  let attemptsRemaining: number;
  let blank: boolean;

  if (trimmed.length === 0) {
    // D-10 (RESEARCH Pitfall 2): blank/whitespace short-circuits BEFORE any
    // lookup or counter write — a blank referral consumes zero attempts.
    valid = false;
    exhausted = false;
    attemptsRemaining = Math.max(0, REFERRAL_MAX_ATTEMPTS - attempts);
    blank = true;
  } else if (attempts >= REFERRAL_MAX_ATTEMPTS) {
    // D-07: already exhausted before this call — no lookup, no further
    // increment (also prevents the counter growing unboundedly under a
    // scripted caller).
    valid = false;
    exhausted = true;
    attemptsRemaining = 0;
    blank = false;
  } else {
    // Reuse the onboarding validity predicate verbatim (auth.ts) so a handle
    // that validates here cannot later fail at submit.
    const [referrer] = await db
      .select({ userId: userProfiles.userId, bannedAt: users.bannedAt })
      .from(userProfiles)
      .innerJoin(users, eq(users.id, userProfiles.userId))
      .where(eq(userProfiles.handle, trimmed.toLowerCase()))
      .limit(1);

    const isValidReferrer =
      referrer != null &&
      referrer.userId !== userId &&
      referrer.bannedAt === null;

    blank = false;

    if (isValidReferrer) {
      // D-04: valid path never writes a `referrals` row — that INSERT stays
      // exclusively in the onboarding submit handler in auth.ts.
      valid = true;
      exhausted = false;
      attemptsRemaining = Math.max(0, REFERRAL_MAX_ATTEMPTS - attempts);
    } else {
      // Invalid: nonexistent handle, self-referral, and a suspended referrer
      // all take this identical branch and produce an identical body (D-06).
      // Atomic per-row increment via the sql template form (not a JS
      // read-modify-write) so two concurrent calls cannot both write the
      // same value (T-34-14).
      await db
        .update(userProfiles)
        .set({ referralAttempts: sql`${userProfiles.referralAttempts} + 1` })
        .where(eq(userProfiles.userId, userId));

      const nextAttempts = attempts + 1;
      valid = false;
      exhausted = nextAttempts >= REFERRAL_MAX_ATTEMPTS;
      attemptsRemaining = Math.max(0, REFERRAL_MAX_ATTEMPTS - nextAttempts);
    }
  }

  res.json({ valid, exhausted, attemptsRemaining, blank });
});

export default router;
