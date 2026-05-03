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

  const tier: Tier = isOrgAdmin
    ? 'org_admin'
    : premiumActive
      ? 'premium'
      : 'free';

  const isPremiumDerived = tier !== 'free';

  // Phase-1 limit table. Numbers are placeholders to be tuned in Phase 4
  // (TIER-01). Use 999 / 9999 instead of the JS sentinel to survive JSON.
  const limits =
    tier === 'free'
      ? { maxBeacons: 1, maxGroupsOwned: 1, maxGroupMembers: 25 }
      : tier === 'premium'
        ? { maxBeacons: 3, maxGroupsOwned: 5, maxGroupMembers: 250 }
        : tier === 'org_admin'
          ? { maxBeacons: 5, maxGroupsOwned: 50, maxGroupMembers: 5000 }
          : { maxBeacons: 999, maxGroupsOwned: 999, maxGroupMembers: 9999 }; // staff

  const features = {
    canCreatePublicGroup: true,
    canCreatePrivateGroup: tier !== 'free',
    canCreateOrg: false, // Phase 2 flips this for premium+ tiers
    canSendDM: true,
    canPostBeacon: true,
    canTranslateMessages: true, // free for all authenticated users — matches existing /api/chat/translate behavior; no premium gate exists server-side
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
