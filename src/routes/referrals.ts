import { Router, Response } from 'express';
import { db } from '../db';
import { referrals, attributionConversions } from '../db/schema';
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

export default router;
