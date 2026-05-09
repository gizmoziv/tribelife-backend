import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { organizations, organizationMemberships } from '../db/schema';
import type { OrgMembership } from '../types/capabilities';

/**
 * Read the authenticated user's active organization memberships, filtered
 * to non-soft-deleted orgs. Returns a plain array suitable for passing
 * directly into `computeCapabilities`.
 *
 * Soft-deleted orgs (organizations.deletedAt IS NOT NULL) are excluded
 * — their members do not surface in caps.orgs[] and admins of
 * soft-deleted orgs are NOT promoted to tier='org_admin' (D-04).
 *
 * Phase 5: Augmented to include slug, name, iconUrl so caps.orgs[] is
 * self-sufficient for OrgCard rendering — no N+1 round-trips on profile
 * mount (RESEARCH.md Pitfall #2).
 */
export async function getOrgMembershipsForUser(userId: number): Promise<OrgMembership[]> {
  const rows = await db
    .select({
      orgId: organizationMemberships.orgId,
      role: organizationMemberships.role,
      slug: organizations.slug,
      name: organizations.name,
      iconUrl: organizations.iconUrl,
    })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.orgId))
    .where(
      and(
        eq(organizationMemberships.userId, userId),
        isNull(organizations.deletedAt),
      ),
    );

  return rows;
}
