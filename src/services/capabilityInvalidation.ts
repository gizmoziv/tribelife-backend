import logger from '../lib/logger';
import { getIO } from '../lib/socketRegistry';
import type { CapsInvalidatedReason } from '../types/capabilities';

const log = logger.child({ module: 'capabilities' });

/**
 * Emit a `caps:invalidated` event to the user's personal socket room so
 * the mobile client can call `refreshCapabilities()` without waiting for
 * an AppState foreground transition (D-01, D-02). Fail-open: any throw
 * from `io.to(...).emit(...)` is logged but never propagated — the DB
 * write that triggered this is the source of truth (D-04).
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
