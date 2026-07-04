---
slug: revenuecat-billing-grace-aware
created: 2026-07-04
type: quick
status: complete
---

# Summary: RevenueCat billing-issue no longer hard-revokes premium

## What changed

- `src/routes/revenuecat.ts`
  - New `SOFT_EXPIRY_EVENTS = ['BILLING_ISSUE', 'SUBSCRIPTION_PAUSED']`; removed
    both from `REVOKE_EVENTS`, which is now `['EXPIRATION']` (terminal revoke only).
  - New `isSoftExpiry` branch: keeps `isPremium: true` and sets
    `premiumExpiresAt = event.expiration_at_ms`, letting the caps predicate govern
    live access (no grace → lapses at/just-past period end; grace → retained
    through grace end). If the event has no numeric `expiration_at_ms`, hard-revoke
    as a safe fallback (cannot bound access otherwise). Emits
    `caps:invalidated` with reason `revenuecat_billing_issue`.
  - Grant path: null-expiry guard — if a grant event lacks a numeric
    `expiration_at_ms`, log an error and skip the premium write (never persist a
    lifetime `null` expiry, which the caps predicate would treat as permanent
    premium). `expiresAt` is now always a real `Date` on the grant path.
- `src/types/capabilities.ts`
  - Added `'revenuecat_billing_issue'` to `CapsInvalidatedReason` (wire hint only;
    client re-fetches caps regardless of value).

Unchanged: grant/attribution/transfer logic, webhook auth, user-id resolution,
`CANCELLATION` no-op.

## Behavior (grace period currently OFF)

- Renewal fails → `BILLING_ISSUE` → premium bounded by `expiration_at_ms` (≈ period
  end) instead of revoked instantly. User keeps only the already-paid remainder of
  the period; no free access during the ~60-day silent retry window.
- Charge recovers → `RENEWAL` re-grants and pushes expiry forward.
- Retry window lapses → `EXPIRATION` hard-revokes.
- Future-proofs enabling a store grace period: access would then be correctly
  retained through the grace end with no further code change.

## Verification

- `npx tsc --noEmit` → exit 0 (backend has no test framework; typecheck is the gate).
- Confirmed branch order grant → soft-expiry → revoke → no-op via grep.
- DB untouched (no scripts run against prod).

## Notes for deploy

- Requires `REVENUECAT_WEBHOOK_SECRET` (already used by the webhook) — no new env.
- No migration; additive logic only.
