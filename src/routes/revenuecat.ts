import { Router, Request, Response } from 'express';
import logger from '../lib/logger';

const log = logger.child({ module: 'revenuecat' });
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { userProfiles, attributionConversions, referrals } from '../db/schema';
import { emitCapabilityInvalidationToUser } from '../services/capabilityInvalidation';

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

// ── User-id resolution helpers ────────────────────────────────────────────────

/**
 * Scan candidate fields on a RevenueCat event and return the first value that
 * parses to a valid positive integer. Strict check — rejects anonymous IDs
 * like `$RCAnonymousID:…` and any non-integer strings.
 * Candidates checked in order: app_user_id → aliases[] → original_app_user_id
 */
function resolveUserId(event: any): number | null {
  const candidates: (string | undefined)[] = [
    event.app_user_id,
    ...(Array.isArray(event.aliases) ? event.aliases : []),
    event.original_app_user_id,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    if (/^\d+$/.test(candidate)) {
      const parsed = parseInt(candidate, 10);
      if (parsed > 0) return parsed;
    }
  }
  return null;
}

/**
 * For TRANSFER events, scan event.transferred_to (array of app_user_ids) and
 * return the first value that parses to a valid positive integer.
 */
function resolveTransferUserId(event: any): number | null {
  const candidates: unknown[] = Array.isArray(event.transferred_to)
    ? event.transferred_to
    : [];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    if (/^\d+$/.test(candidate)) {
      const parsed = parseInt(candidate, 10);
      if (parsed > 0) return parsed;
    }
  }
  return null;
}

// ── Webhook handler ───────────────────────────────────────────────────────────

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
    const expirationAtMs: number | undefined = event.expiration_at_ms;

    // ── TRANSFER: grant premium to the receiving user ─────────────────────────
    if (eventType === 'TRANSFER') {
      const userId = resolveTransferUserId(event);
      if (userId === null) {
        log.warn(
          {
            appUserId: event.app_user_id,
            eventType,
            transactionId: event.transaction_id ?? event.id,
          },
          'RevenueCat webhook: could not resolve user id — purchase not attributed',
        );
        res.json({ ok: true });
        return;
      }

      const revenuecatCustomerId = String(
        event.original_app_user_id ?? event.app_user_id ?? userId,
      );

      await db
        .update(userProfiles)
        .set({
          isPremium: true,
          revenuecatCustomerId,
          updatedAt: new Date(),
        })
        .where(eq(userProfiles.userId, userId));

      emitCapabilityInvalidationToUser(userId, 'revenuecat_grant');
      log.info({ eventType, userId }, 'Granted premium (transfer)');
      res.json({ ok: true });
      return;
    }

    // ── All other events: resolve user id via aliases / app_user_id ──────────
    const userId = resolveUserId(event);

    if (userId === null) {
      log.warn(
        {
          appUserId: event.app_user_id,
          eventType,
          transactionId: event.transaction_id ?? event.id,
        },
        'RevenueCat webhook: could not resolve user id — purchase not attributed',
      );
      res.json({ ok: true });
      return;
    }

    const isGrant = (GRANT_EVENTS as readonly string[]).includes(eventType);
    const isRevoke = (REVOKE_EVENTS as readonly string[]).includes(eventType);

    if (isGrant) {
      const expiresAt = expirationAtMs ? new Date(expirationAtMs) : null;
      const revenuecatCustomerId = String(
        event.original_app_user_id ?? event.app_user_id ?? userId,
      );

      await db
        .update(userProfiles)
        .set({
          isPremium: true,
          premiumExpiresAt: expiresAt,
          revenuecatCustomerId,
          updatedAt: new Date(),
        })
        .where(eq(userProfiles.userId, userId));

      // Phase 13: record attribution conversion for INITIAL_PURCHASE only
      // (RENEWAL / PRODUCT_CHANGE / UNCANCELLATION are explicitly out of scope per D-02)
      if (eventType === 'INITIAL_PURCHASE') {
        const revenuecatEventId: string | undefined = event.id;
        const productId: string | undefined = event.product_id;

        // Look up first-touch referrer locked at signup (oldest row for this user)
        const [referralRow] = await db
          .select({ referrerId: referrals.referrerId, source: referrals.source })
          .from(referrals)
          .where(eq(referrals.referredUserId, userId))
          .limit(1);

        await db
          .insert(attributionConversions)
          .values({
            referredUserId: userId,
            referrerUserId: referralRow?.referrerId ?? null,
            source: referralRow?.source ?? 'organic',
            plan: productId ?? null,
            revenuecatEventId: revenuecatEventId ?? null,
          })
          .onConflictDoNothing(); // idempotent on revenuecat_event_id UNIQUE

        log.info(
          {
            eventType,
            userId,
            referrerUserId: referralRow?.referrerId ?? null,
            source: referralRow?.source ?? 'organic',
          },
          'Attribution recorded'
        );
      }

      emitCapabilityInvalidationToUser(userId, 'revenuecat_grant');
      log.info({ eventType, userId }, 'Granted premium');
    } else if (isRevoke) {
      await db
        .update(userProfiles)
        .set({
          isPremium: false,
          updatedAt: new Date(),
        })
        .where(eq(userProfiles.userId, userId));

      emitCapabilityInvalidationToUser(userId, 'revenuecat_revoke');
      log.info({ eventType, userId }, 'Revoked premium');
    } else {
      // CANCELLATION, etc. — log but no action needed
      // CANCELLATION just means auto-renew is off; user keeps access until expiration
      log.info({ eventType, userId }, 'No action for event');
    }

    res.json({ ok: true });
  } catch (err) {
    log.error({ err }, 'Webhook processing failed');
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;
