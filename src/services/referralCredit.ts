import { eq, count } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { db } from '../db';
import * as schema from '../db/schema';
import { referrals, userProfiles, users } from '../db/schema';
import logger from '../lib/logger';

const log = logger.child({ module: 'referralCredit' });

// Referral effects (referrer premium months, joiner premium days, the
// `referrals` row) fire from one of two call sites depending on whether the
// joiner was routed into access review (Phase 36): ungated joiners get them at
// /onboarding (auth.ts), review-gated joiners get them deferred to admin
// approval (admin.ts). One implementation keeps the two from drifting.
//
// Every helper takes the executor it must run on because the approve call site
// needs them inside its own db.transaction — approval and credit must commit
// or roll back together, and the transaction already holds a row lock on the
// joiner's user_profiles row, so a write to it over a separate pooled
// connection would deadlock. The imported `db` appears only as the default
// value of the optional executor parameters (the non-transactional onboarding
// caller), never in a query body.

// Anything queries can run on: the module-level `db` or the `tx` handed to
// db.transaction(async (tx) => ...).
export type ReferralCreditExecutor = NodePgDatabase<typeof schema>;

// Free-premium days granted to a net-new joiner who provides a valid referrer
// (REF-06). Read per call, never cached at module scope.
export function getJoinerPremiumDays(): number {
  return parseInt(process.env.REFERRAL_JOINER_PREMIUM_DAYS || '14', 10);
}

// REF-07: 1 referral = 1 month, cap at 12. Recomputed from the live count
// (never incremented) so a repeated call converges instead of compounding.
export async function grantReferrerPremiumMonths(
  referrerUserId: number,
  exec: ReferralCreditExecutor = db,
): Promise<number> {
  const [countResult] = await exec
    .select({ total: count() })
    .from(referrals)
    .where(eq(referrals.referrerId, referrerUserId));

  const totalReferrals = Math.min(countResult?.total ?? 0, 12);
  if (totalReferrals > 0) {
    const premiumExpiry = new Date();
    premiumExpiry.setMonth(premiumExpiry.getMonth() + totalReferrals);
    await exec
      .update(userProfiles)
      .set({
        isPremium: true,
        premiumExpiresAt: premiumExpiry,
        updatedAt: new Date(),
      })
      .where(eq(userProfiles.userId, referrerUserId));
  }
  return totalReferrals;
}

// REF-06: grant the joiner free premium only when they lack active premium.
// Predicate mirrors capabilities.ts: isPremium && (premiumExpiresAt === null
// || premiumExpiresAt > now). Returns the new expiry so a caller can sync an
// in-memory profile object.
export async function grantJoinerPremiumIfEligible(
  joinerUserId: number,
  referrerUserId: number,
  exec: ReferralCreditExecutor = db,
): Promise<{ granted: boolean; premiumExpiresAt: Date | null }> {
  const [joiner] = await exec
    .select({
      isPremium: userProfiles.isPremium,
      premiumExpiresAt: userProfiles.premiumExpiresAt,
    })
    .from(userProfiles)
    .where(eq(userProfiles.userId, joinerUserId))
    .limit(1);

  const now = new Date();
  const joinerHasActivePremium =
    joiner != null &&
    joiner.isPremium &&
    (joiner.premiumExpiresAt === null || joiner.premiumExpiresAt > now);

  if (joinerHasActivePremium) {
    return { granted: false, premiumExpiresAt: null };
  }

  const days = getJoinerPremiumDays();
  const premiumExpiry = new Date(Date.now() + days * 86400000);
  await exec
    .update(userProfiles)
    .set({
      isPremium: true,
      premiumExpiresAt: premiumExpiry,
      updatedAt: new Date(),
    })
    .where(eq(userProfiles.userId, joinerUserId));

  log.info(
    { userId: joinerUserId, referrerId: referrerUserId, days },
    '[attribution] joiner premium granted',
  );
  return { granted: true, premiumExpiresAt: premiumExpiry };
}

// D-06: the standard referral effects for a review-gated joiner, run once on
// the admin's transition INTO approved. `exec` is the first and required
// parameter so no call site can forget it and silently fall back to an
// out-of-transaction connection. Errors propagate — nothing is caught here, so
// a failure rolls back the whole approve transaction (no partial credit for
// the duplicate guard below to mask).
export async function applyReferralCreditOnApproval(
  exec: ReferralCreditExecutor,
  opts: {
    referredUserId: number;
    referrerUserId: number;
    source: string | null;
  },
): Promise<'applied' | 'skipped_existing' | 'skipped_referrer_invalid'> {
  const { referredUserId, referrerUserId, source } = opts;

  // 1. Referrer must still exist and not be banned at approval time (REF-09).
  const [referrer] = await exec
    .select({ handle: userProfiles.handle, bannedAt: users.bannedAt })
    .from(userProfiles)
    .innerJoin(users, eq(users.id, userProfiles.userId))
    .where(eq(userProfiles.userId, referrerUserId))
    .limit(1);

  if (!referrer || referrer.bannedAt !== null) {
    log.warn(
      {
        userId: referredUserId,
        referrerId: referrerUserId,
        reason: !referrer ? 'referrer_missing' : 'referrer_banned',
      },
      '[attribution] approval credit skipped',
    );
    return 'skipped_referrer_invalid';
  }

  // 2. Duplicate guard: `referrals` has no unique constraint on
  // referred_user_id, so without this a re-approve would insert a second row
  // and inflate the referrer's month count.
  const [existing] = await exec
    .select({ id: referrals.id })
    .from(referrals)
    .where(eq(referrals.referredUserId, referredUserId))
    .limit(1);

  if (existing) {
    log.warn(
      {
        userId: referredUserId,
        referrerId: referrerUserId,
        reason: 'referral_exists',
      },
      '[attribution] approval credit skipped',
    );
    return 'skipped_existing';
  }

  // 3. The referrals row (referralCode is the referrer's handle right now).
  await exec.insert(referrals).values({
    referrerId: referrerUserId,
    referredUserId,
    referralCode: referrer.handle,
    status: 'onboarded',
    convertedAt: new Date(),
    source: source ?? 'handle_code',
  });

  // 4-5. Premium effects, on the same executor.
  const months = await grantReferrerPremiumMonths(referrerUserId, exec);
  const joiner = await grantJoinerPremiumIfEligible(
    referredUserId,
    referrerUserId,
    exec,
  );

  log.info(
    {
      userId: referredUserId,
      referrerId: referrerUserId,
      months,
      joinerGranted: joiner.granted,
    },
    '[attribution] approval credit applied',
  );
  return 'applied';
}
