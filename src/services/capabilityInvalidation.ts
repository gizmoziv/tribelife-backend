import { eq } from 'drizzle-orm';
import { db } from '../db';
import { userProfiles, globeRoomMemberships } from '../db/schema';
import logger from '../lib/logger';
import { getIO } from '../lib/socketRegistry';
import type { CapsInvalidatedReason } from '../types/capabilities';
import { computeCapabilities } from './capabilities';
import { getOrgMembershipsForUser } from './orgMemberships';
import {
  isValidTimezoneRoom,
  getZoneForTimezone,
} from '../config/timezoneZones';
import { callerCanAccessNonNativeTimezone } from '../lib/timezoneRoomAccess';

const log = logger.child({ module: 'capabilities' });

/**
 * Emit a `caps:invalidated` event to the user's personal socket room so
 * the mobile client can call `refreshCapabilities()` without waiting for
 * an AppState foreground transition (D-01, D-02). Fail-open: any throw
 * from `io.to(...).emit(...)` is logged but never propagated — the DB
 * write that triggered this is the source of truth (D-04).
 *
 * Phase 15 (D-09): after the emit, if the user's NEW capability snapshot
 * no longer grants non-native timezone access, iterate each of their
 * active sockets and `socket.leave('globe-feed:<slug>')` for every joined
 * non-native timezone room. DB membership rows are NEVER deleted on
 * downgrade — only socket subscriptions are dropped, so a re-upgrade
 * automatically restores access on next socket reconnect.
 */
export function emitCapabilityInvalidationToUser(
  userId: number,
  reason: CapsInvalidatedReason,
): void {
  const io = getIO();
  if (!io) {
    log.warn({ userId, reason }, 'caps:invalidated emit skipped — no io');
    return;
  }
  try {
    io.to(`user:${userId}`).emit('caps:invalidated', { reason });
  } catch (err) {
    log.error({ err, userId, reason }, 'caps:invalidated emit failed');
  }

  // Phase 15 D-09: downgrade eviction (fire-and-forget; failures log only).
  // Re-fetches caller's profile + org memberships, recomputes caps; if the
  // user STILL has non-native timezone access, no eviction is needed
  // (covers both upgrade and no-op caps:invalidated emits). On downgrade,
  // iterate the user's active sockets and leave each non-native timezone
  // feed room individually. DB rows in globe_room_memberships are NEVER
  // touched here.
  void (async () => {
    try {
      const [profile] = await db
        .select({
          isPremium: userProfiles.isPremium,
          premiumExpiresAt: userProfiles.premiumExpiresAt,
          timezone: userProfiles.timezone,
        })
        .from(userProfiles)
        .where(eq(userProfiles.userId, userId))
        .limit(1);
      if (!profile) return;

      const orgMemberships = await getOrgMembershipsForUser(userId);
      const caps = computeCapabilities({
        isPremium: profile.isPremium,
        premiumExpiresAt: profile.premiumExpiresAt,
        orgMemberships,
      });
      if (callerCanAccessNonNativeTimezone(caps)) return;

      const memberships = await db
        .select({ roomSlug: globeRoomMemberships.roomSlug })
        .from(globeRoomMemberships)
        .where(eq(globeRoomMemberships.userId, userId));
      const callerNativeSlug = getZoneForTimezone(profile.timezone ?? 'UTC');
      const droppedSlugs = memberships
        .map((m) => m.roomSlug)
        .filter((s) => isValidTimezoneRoom(s) && s !== callerNativeSlug);
      if (droppedSlugs.length === 0) return;

      const userSockets = await io.in('user:' + userId).fetchSockets();
      for (const sock of userSockets) {
        for (const slug of droppedSlugs) {
          sock.leave('globe-feed:' + slug);
        }
      }
      log.info(
        { userId, droppedSlugs, reason },
        '[caps reflow] dropped non-native timezone subscriptions',
      );
    } catch (err) {
      log.error({ err, userId, reason }, '[caps reflow] failed');
    }
  })();
}

/**
 * Fan-out variant for soft-deletes and other multi-user invalidations
 * (e.g. an org admin soft-deleting an org affects every member's caps).
 * Each per-user emit logs independently (one log line per failure), and
 * a failure on one user does not skip subsequent users.
 */
export function emitCapabilityInvalidationToUsers(
  userIds: number[],
  reason: CapsInvalidatedReason,
): void {
  for (const userId of userIds) {
    emitCapabilityInvalidationToUser(userId, reason);
  }
}
