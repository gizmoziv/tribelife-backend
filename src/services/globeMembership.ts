import { db } from '../db';
import { globeRoomMemberships } from '../db/schema';
import { GLOBE_ROOMS } from '../config/globeRooms';
import { eq } from 'drizzle-orm';

/**
 * Insert globe_room_memberships rows for every autoJoin=true room.
 * Idempotent — ON CONFLICT DO NOTHING makes re-runs safe on every signin (D-06).
 */
export async function bootstrapAutoJoins(userId: number): Promise<void> {
  const autoJoinSlugs = GLOBE_ROOMS.filter(r => r.autoJoin).map(r => r.slug);
  if (autoJoinSlugs.length === 0) return;
  await db
    .insert(globeRoomMemberships)
    .values(autoJoinSlugs.map(roomSlug => ({ userId, roomSlug })))
    .onConflictDoNothing({ target: [globeRoomMemberships.userId, globeRoomMemberships.roomSlug] });
}

/**
 * Returns the set of Globe room slugs the user is a member of.
 * O(1) .has() checks for per-room membership gates (D-14).
 * Town Square is included when present (every user has it via bootstrapAutoJoins).
 */
export async function getGlobeMembershipsForUser(userId: number): Promise<Set<string>> {
  const rows = await db
    .select({ roomSlug: globeRoomMemberships.roomSlug })
    .from(globeRoomMemberships)
    .where(eq(globeRoomMemberships.userId, userId));
  return new Set(rows.map((r) => r.roomSlug));
}

/**
 * Returns the set of userIds who are members of a given Globe room slug.
 * Used for NOTIF-03 mention intersection: a mention of a non-member produces
 * no notification for that user.
 */
export async function getGlobeMembershipsForRoomSlug(roomSlug: string): Promise<Set<number>> {
  const rows = await db
    .select({ userId: globeRoomMemberships.userId })
    .from(globeRoomMemberships)
    .where(eq(globeRoomMemberships.roomSlug, roomSlug));
  return new Set(rows.map((r) => r.userId));
}
