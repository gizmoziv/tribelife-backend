// Server-driven authorization capabilities for the authenticated user.
// Computed fresh on every protected response — never trust this from a
// token claim. Phase 1 establishes the shape; subsequent v1.5 phases
// extend it (orgs in Phase 2, broader tier wiring in Phase 4, etc.).

export const CAPABILITIES_VERSION = 1;

export type Tier = 'free' | 'premium' | 'org_admin' | 'staff';

export type OrgRole = 'admin' | 'moderator' | 'member';

export interface OrgMembership {
  orgId: number;
  role: OrgRole;
  slug: string;
  name: string;
  iconUrl: string | null;
}

export interface CapabilityLimits {
  maxBeacons: number;
  maxGroupsOwned: number;
  maxGroupMembers: number;
  maxOrgsOwned: number;
}

export interface CapabilityFeatures {
  canCreatePublicGroup: boolean;
  canCreatePrivateGroup: boolean;
  canCreateOrg: boolean;
  canSendDM: boolean;
  canPostBeacon: boolean;
  canTranslateMessages: boolean;
}

export interface Capabilities {
  version: number;
  computedAt: string;
  tier: Tier;
  isPremium: boolean;
  limits: CapabilityLimits;
  features: CapabilityFeatures;
  orgs: OrgMembership[];
}

// ── Phase 8: caps:invalidated event types (D-01) ───────────────────────────
// The payload mobile receives over the socket is just `{ reason }`; the
// mobile client then re-fetches /api/auth/capabilities. Decouples emit-site
// from caps shape so future shape changes don't have to be mirrored in
// five mutation routes (per CONTEXT.md D-01 rationale).

export type CapsInvalidatedReason =
  | 'revenuecat_grant'
  | 'revenuecat_revoke'
  | 'org_create'
  | 'org_invite_accept'
  | 'org_role_change'
  | 'org_soft_delete';

export interface CapsInvalidatedPayload {
  reason: CapsInvalidatedReason;
}
