import {
  Capabilities,
  CAPABILITIES_VERSION,
  OrgMembership,
  Tier,
} from '../types/capabilities';

/**
 * Compute the authenticated user's capabilities object from their current
 * profile state. Pure function — no IO, no side effects.
 *
 * Premium-expired (D-02): if `premiumExpiresAt` is non-null AND in the
 * past, treat `premiumActive=false` even when `isPremium=true` on the
 * profile row. Tier collapses to 'free' (or 'org_admin' once orgs land
 * in Phase 2).
 *
 * Phase 1 returns an empty `orgs[]` placeholder. Phase 2 will join
 * organization_memberships and populate the array.
 */
export function computeCapabilities(args: {
  isPremium: boolean;
  premiumExpiresAt: Date | null;
  orgMemberships?: OrgMembership[];
}): Capabilities {
  const now = new Date();
  const premiumActive =
    args.isPremium &&
    (args.premiumExpiresAt === null || args.premiumExpiresAt > now);

  const orgs = args.orgMemberships ?? [];
  const isOrgAdmin = orgs.some((m) => m.role === 'admin');

  // Two orthogonal axes:
  //   1. Personal subscription state (premiumActive — driven by paid premium)
  //   2. Org role state (isOrgAdmin — driven by membership rows)
  //
  // PERSONAL features and limits are driven by axis 1 ONLY. Being appointed
  // as an org admin does NOT grant personal premium features (private
  // groups, elevated beacon limits, etc.) — that would let any user dodge
  // the $4.99/mo subscription by getting appointed to an org.
  //
  // ORG-axis limits (maxOrgsOwned) are driven by axis 2 ONLY.
  //
  // `tier` is a UI label combining both axes (org_admin > premium > free).
  // It is NOT used as a key into the limits/features table.

  const tier: Tier = isOrgAdmin
    ? 'org_admin'
    : premiumActive
      ? 'premium'
      : 'free';

  // isPremium reflects PAID personal subscription only. An org admin who
  // hasn't paid is NOT premium. This was previously `tier !== 'free'` which
  // produced false positives for unpaid org admins.
  const isPremiumDerived = premiumActive;

  const personalLimits = premiumActive
    ? { maxBeacons: 3, maxGroupsOwned: 5, maxGroupMembers: 250 }
    : { maxBeacons: 1, maxGroupsOwned: 1, maxGroupMembers: 25 };

  const limits = {
    ...personalLimits,
    maxOrgsOwned: isOrgAdmin ? 1 : 0,
  };

  const features = {
    canCreatePublicGroup: true,
    canCreatePrivateGroup: premiumActive, // PAID premium only — org admin role does not unlock
    canCreateOrg: false, // org creation is operator-driven today; future tiers will gate self-serve when verification + count enforcement land
    canSendDM: true,
    canPostBeacon: true,
    canTranslateMessages: true, // free for all authenticated users — matches existing /api/chat/translate behavior
  };

  return {
    version: CAPABILITIES_VERSION,
    computedAt: now.toISOString(),
    tier,
    isPremium: isPremiumDerived,
    limits,
    features,
    orgs,
  };
}
