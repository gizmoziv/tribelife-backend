import { Router, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { userProfiles } from '../db/schema';

const router = Router();

// RevenueCat webhook event types that grant/revoke premium
const GRANT_EVENTS = [
  'INITIAL_PURCHASE',
  'RENEWAL',
  'PRODUCT_CHANGE',        // upgraded/crossgraded
  'UNCANCELLATION',        // user re-enabled auto-renew
] as const;

const REVOKE_EVENTS = [
  'EXPIRATION',
  'BILLING_ISSUE',
  'SUBSCRIPTION_PAUSED',
] as const;

router.post('/webhook', async (req: Request, res: Response): Promise<void> => {
  // Verify webhook auth
  const secret = req.headers['authorization'];
  if (secret !== `Bearer ${process.env.REVENUECAT_WEBHOOK_SECRET}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const { event } = req.body;

    if (!event) {
      res.status(400).json({ error: 'Missing event' });
      return;
    }

    const eventType: string = event.type;
    const appUserId: string | undefined = event.app_user_id;
    const expirationAtMs: number | undefined = event.expiration_at_ms;

    if (!appUserId) {
      res.status(400).json({ error: 'Missing app_user_id' });
      return;
    }

    // RevenueCat app_user_id is our userId (set during SDK configure)
    const userId = parseInt(appUserId, 10);
    if (isNaN(userId)) {
      // Could be a RevenueCat anonymous ID — ignore
      res.json({ ok: true });
      return;
    }

    const isGrant = (GRANT_EVENTS as readonly string[]).includes(eventType);
    const isRevoke = (REVOKE_EVENTS as readonly string[]).includes(eventType);

    if (isGrant) {
      const expiresAt = expirationAtMs ? new Date(expirationAtMs) : null;

      await db
        .update(userProfiles)
        .set({
          isPremium: true,
          premiumExpiresAt: expiresAt,
          updatedAt: new Date(),
        })
        .where(eq(userProfiles.userId, userId));

      console.log(`[revenuecat] ${eventType}: granted premium to user ${userId}`);
    } else if (isRevoke) {
      await db
        .update(userProfiles)
        .set({
          isPremium: false,
          updatedAt: new Date(),
        })
        .where(eq(userProfiles.userId, userId));

      console.log(`[revenuecat] ${eventType}: revoked premium from user ${userId}`);
    } else {
      // CANCELLATION, TRANSFER, etc. — log but no action needed
      // CANCELLATION just means auto-renew is off; user keeps access until expiration
      console.log(`[revenuecat] ${eventType}: no action for user ${userId}`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[revenuecat/webhook]', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;
