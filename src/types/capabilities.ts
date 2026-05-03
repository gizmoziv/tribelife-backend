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
}

export interface CapabilityLimits {
  maxBeacons: number;
  maxGroupsOwned: number;
  maxGroupMembers: number;
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
