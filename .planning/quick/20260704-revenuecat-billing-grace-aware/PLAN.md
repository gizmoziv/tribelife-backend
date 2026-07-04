---
slug: revenuecat-billing-grace-aware
created: 2026-07-04
type: quick
status: in-progress
---

# Fix: RevenueCat billing-issue should not hard-revoke premium

## Problem

`src/routes/revenuecat.ts` lists `BILLING_ISSUE` (and `SUBSCRIPTION_PAUSED`) in
`REVOKE_EVENTS`, so a **failed renewal** immediately sets `isPremium: false`.

That is wrong in two ways:
1. Apple/Google attempt the renewal charge shortly *before* the paid period ends.
   A failure there fires `BILLING_ISSUE` while the user is still inside the period
   they already paid for → we revoke up to ~a day of paid access early.
2. It is a landmine for enabling a **billing grace period** later (a standard
   involuntary-churn reducer): the moment grace is turned on, this code would
   revoke the instant `BILLING_ISSUE` fires, defeating the grace period entirely.

Store config note: grace period is currently **OFF**, so there is no "free
premium during retry" risk — without grace the subscription is inactive during
the ~60-day retry window. This fix keeps that correct while removing the
premature-revoke and future-proofing grace.

Separately, the grant path (`revenuecat.ts:146`) writes
`premiumExpiresAt = expirationAtMs ? new Date(...) : null`, and the caps predicate
(`services/capabilities.ts:27`) treats `null` as "never expires" — so a grant
event lacking `expiration_at_ms` would grant **permanent** free premium.

## Fix

1. **Soft-expiry events.** Move `BILLING_ISSUE` + `SUBSCRIPTION_PAUSED` out of
   `REVOKE_EVENTS` into a new `SOFT_EXPIRY_EVENTS` bucket. For these: keep
   `isPremium: true` and set `premiumExpiresAt = event.expiration_at_ms`, letting
   the caps predicate govern live access:
   - no grace → expiration is at/just-past period end → access lapses on schedule;
   - grace on → expiration is the grace-period end → access retained through it.
   If the event carries no `expiration_at_ms`, fall back to a hard revoke (safe).

2. **Terminal revoke only on `EXPIRATION`** (`REVOKE_EVENTS = ['EXPIRATION']`).

3. **Null-expiry guard on grants.** If a grant event lacks a numeric
   `expiration_at_ms`, log an error and skip the premium write — never persist a
   lifetime (`null`) expiry from a webhook.

4. Add `'revenuecat_billing_issue'` to `CapsInvalidatedReason` for the soft path.

## Constraints

- Do NOT touch the DB (prod). No behavior change to grant/attribution/transfer.
- Backend has no test framework — verify via `tsc` typecheck only.

## Files

- `src/routes/revenuecat.ts`
- `src/types/capabilities.ts` (add one reason to the union)

## Verification

- `npx tsc --noEmit` passes.
- Trace: BILLING_ISSUE with future expiry → isPremium stays true, expiry set →
  premiumActive true until expiry; with no/absent expiry → access lapses/revokes.
