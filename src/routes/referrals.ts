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
const FUNNEL_SOURCES = ['handle_code', 'profile_share', 'group_invite'] as const;
type FunnelSource = (typeof FUNNEL_SOURCES)[number];

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

  const signupMap: Record<string, number> = {};
  for (const row of signupRows) {
    if (row.source) signupMap[row.source] = Number(row.total);
  }
  const paidMap: Record<string, number> = {};
  for (const row of paidRows) {
    if (row.source) paidMap[row.source] = Number(row.total);
  }

  // Always include all three known sources with zero defaults so the UI can
  // render a stable layout even when no rows exist for a given channel.
  const bySource = FUNNEL_SOURCES.reduce(
    (acc, src: FunnelSource) => {
      acc[src] = {
        joined: signupMap[src] ?? 0,
        paid: paidMap[src] ?? 0,
      };
      return acc;
    },
    {} as Record<FunnelSource, { joined: number; paid: number }>,
  );

  const totalReferrals =
    bySource.handle_code.joined +
    bySource.profile_share.joined +
    bySource.group_invite.joined;
  const totalPremiumMonths = Math.min(totalReferrals, 12);

  res.json({ bySource, totalPremiumMonths });
});

export default router;
