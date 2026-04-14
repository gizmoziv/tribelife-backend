import { Router, Response } from 'express';
import { db } from '../db';
import { referrals } from '../db/schema';
import { eq, count } from 'drizzle-orm';
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

export default router;
