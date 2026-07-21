/**
 * User audit events (AUDIT-01)
 *
 * Append-only trail of discrete, meaningful user actions (login,
 * account_deleted, image_uploaded). Deliberately does NOT record high-frequency
 * activity — "last seen" lives on user_profiles.last_active_at instead.
 *
 * logUserEvent NEVER throws: an audit-write failure must not break the request
 * that triggered it. Pass userId = null for events that must stay untethered
 * from a person (e.g. account_deleted).
 */
import { db } from '../db';
import { userEvents } from '../db/schema';
import logger from '../lib/logger';

const log = logger.child({ module: 'user-events' });

export type UserEventType =
  | 'login'
  | 'account_deleted'
  | 'image_uploaded'
  | 'marketplace_item_click';

export async function logUserEvent(
  userId: number | null,
  eventType: UserEventType,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(userEvents).values({
      userId,
      eventType,
      metadata: metadata ?? null,
    });
  } catch (err) {
    // Swallow — auditing is best-effort and must never fail the caller.
    log.error({ err, eventType, userId }, 'Failed to write user event');
  }
}
