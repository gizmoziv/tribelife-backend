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

// Renewal-failure / pause events: DO NOT hard-revoke. Access is governed by the
// subscription's own expiration_at_ms. With no store grace period, that timestamp
// is at/just-before the period end, so premiumActive lapses on schedule; if grace
// is ever enabled, expiration_at_ms carries the grace-period end and access is
// correctly retained through it. The terminal hard-revoke happens on EXPIRATION.
const SOFT_EXPIRY_EVENTS = [
  'BILLING_ISSUE',        // renewal charge failed — store retries in the background
  'SUBSCRIPTION_PAUSED',  // Android pause — access continues until current period ends
] as const;

// Only a true expiration hard-revokes premium.
const REVOKE_EVENTS = [
  'EXPIRATION',
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
    const isSoftExpiry = (SOFT_EXPIRY_EVENTS as readonly string[]).includes(eventType);
    const isRevoke = (REVOKE_EVENTS as readonly string[]).includes(eventType);

    if (isGrant) {
      // A subscription grant must carry an expiration. Never persist a null
      // (lifetime) premiumExpiresAt from a webhook — the caps predicate
      // (services/capabilities.ts) treats null as "never expires", so a
      // malformed event would grant permanent free premium. Skip instead.
      if (typeof expirationAtMs !== 'number') {
        log.error(
          { eventType, userId, transactionId: event.transaction_id ?? event.id },
          'Grant event missing expiration_at_ms — skipping premium write to avoid a lifetime grant',
        );
        res.json({ ok: true });
        return;
      }

      const expiresAt = new Date(expirationAtMs);
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
    } else if (isSoftExpiry) {
      // Renewal failed (BILLING_ISSUE) or subscription paused. Do NOT hard-revoke:
      // keep isPremium=true and let premiumExpiresAt (from the event) govern live
      // access via the caps predicate — no grace period → expiration is at/just-past
      // the period end (access lapses now/soon); grace enabled → expiration is the
      // grace-period end (access retained through it). EXPIRATION later performs the
      // terminal hard-revoke. If the event carries no expiration, we cannot bound
      // access safely → fall back to a hard revoke.
      if (typeof expirationAtMs !== 'number') {
        await db
          .update(userProfiles)
          .set({ isPremium: false, updatedAt: new Date() })
          .where(eq(userProfiles.userId, userId));

        emitCapabilityInvalidationToUser(userId, 'revenuecat_billing_issue');
        log.warn(
          { eventType, userId },
          'Soft-expiry event missing expiration_at_ms — revoking premium as a safe fallback',
        );
      } else {
        const expiresAt = new Date(expirationAtMs);
        await db
          .update(userProfiles)
          .set({
            isPremium: true,
            premiumExpiresAt: expiresAt,
            updatedAt: new Date(),
          })
          .where(eq(userProfiles.userId, userId));

        emitCapabilityInvalidationToUser(userId, 'revenuecat_billing_issue');
        log.info(
          { eventType, userId, premiumExpiresAt: expiresAt.toISOString() },
          'Soft expiry — access bounded by expiration_at_ms (no immediate revoke)',
        );
      }
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
