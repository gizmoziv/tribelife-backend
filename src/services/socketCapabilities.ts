/**
 * Socket-side capability check helper.
 *
 * Phase 3 builds this helper but no socket event consumes it (D-03) — the
 * helper exists so future product rules can wire socket-layer gates trivially
 * without re-deciding the architecture. Boolean gates on `dm:message`,
 * `room:message`, `typing:*` etc. would import this and short-circuit the
 * handler the same way `requireCapability` short-circuits HTTP routes.
 *
 * Reads the `userId` attached by the socket auth middleware (set in
 * `src/socket/index.ts` at handshake time as `socket.data.userId`), fetches
 * the userProfiles row + active org memberships, computes capabilities via
 * the same `computeCapabilities` service used by HTTP routes, and returns
 * the boolean feature flag.
 */
import type { Socket } from 'socket.io';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users, userProfiles } from '../db/schema';
import { computeCapabilities } from './capabilities';
import { getOrgMembershipsForUser } from './orgMemberships';
import type { CapabilityFeatures } from '../types/capabilities';

export async function checkSocketCapability(
  socket: Socket & { data: { userId?: number } },
  key: keyof CapabilityFeatures,
): Promise<boolean> {
  const userId = socket.data?.userId;
  if (!userId) return false;

  const [row] = await db
    .select({
      isPremium: userProfiles.isPremium,
      premiumExpiresAt: userProfiles.premiumExpiresAt,
    })
    .from(users)
    .leftJoin(userProfiles, eq(users.id, userProfiles.userId))
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return false;

  const orgMemberships = await getOrgMembershipsForUser(userId);
  const caps = computeCapabilities({
    isPremium: row.isPremium ?? false,
    premiumExpiresAt: row.premiumExpiresAt ?? null,
    orgMemberships,
  });
  return caps.features[key] === true;
}
