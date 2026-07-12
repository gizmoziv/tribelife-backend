import { Server } from 'socket.io';
import logger from '../lib/logger';

const log = logger.child({ module: 'socket:active-viewing' });

// ── Active-viewing registry (260621-un7) ─────────────────────────────────────
// Per-socket in-memory state ("which room is this socket viewing" + "is the app
// foregrounded") lives on `socket.data.activeRoomKey` / `socket.data.isForeground`
// (set/cleared by the four `viewing:*` / `app:*` handlers in socket/index.ts).
// This module is the SINGLE SOURCE OF TRUTH for:
//   1. canonicalizing a roomKey to one viewing identity per zone, and
//   2. deciding whether a recipient is actively viewing a given room so all three
//      notification channels (chat:notification emit, notifications row insert,
//      push) can be skipped together with identical logic.
//
// No DB schema change — state is purely in-memory per-socket and dies with the
// socket (locked spec). Multi-device is SIMPLE: if ANY of the user's foregrounded
// sockets is viewing the room, suppress to the whole user.

/**
 * Collapse a screen-level roomKey to ONE canonical viewing identity per zone.
 *
 * A single logical timezone zone is addressed by two screen-level IDs —
 * `timezone:<slug>` (Local Chat) vs `globe:<slug>` (Globe view) — but they share
 * the same message feed. Mirror `canonicalRoomId()` in routes/pins.ts (lines
 * 24-28) so a zone has exactly ONE viewing identity regardless of screen.
 * `globe:*` and `conversation:*` keys pass through unchanged.
 *
 * KEEP IN LOCK-STEP with pins.ts:canonicalRoomId — the 3-line collapse logic is
 * duplicated (not imported) to avoid coupling the socket layer to a route module.
 */
export function canonicalViewingKey(roomKey: string): string {
  if (roomKey.startsWith('globe:')) return roomKey;
  if (roomKey.startsWith('timezone:')) {
    return 'globe:' + roomKey.slice('timezone:'.length);
  }
  return roomKey;
}

/**
 * True if ANY of the user's foregrounded sockets is currently viewing `roomKey`.
 *
 * Uses `io.in('user:'+userId).fetchSockets()` — cross-pod via the Redis adapter
 * in production (NOT `adapter.rooms`, which is local-pod only and undercounts).
 * One `fetchSockets()` round-trip per recipient. The recipient is "actively
 * viewing" only when a socket has BOTH `isForeground === true` AND
 * `activeRoomKey === canonical(roomKey)` — backgrounding nulls `activeRoomKey`
 * and flips `isForeground`, so push resumes immediately.
 */
export async function isUserActivelyViewing(
  io: Server,
  userId: number,
  roomKey: string,
): Promise<boolean> {
  const canonical = canonicalViewingKey(roomKey);
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  const viewing = sockets.some(
    (s) =>
      s.data.isForeground === true && s.data.activeRoomKey === canonical,
  );
  // DEBUG (260712 phase-1 #1): gated probe to root-cause the public-group
  // in-room push leak. Enable with DEBUG_ACTIVE_VIEWING=true, reproduce once
  // (sit in the group, have someone send a plain message), read the log, then
  // disable. Reveals WHY the gate returned false: no sockets in the user room,
  // a stale/absent activeRoomKey, a key mismatch, or isForeground:false.
  if (process.env.DEBUG_ACTIVE_VIEWING === 'true') {
    log.info(
      {
        userId,
        roomKey,
        canonical,
        viewing,
        socketCount: sockets.length,
        sockets: sockets.map((s) => ({
          activeRoomKey: s.data.activeRoomKey ?? null,
          isForeground: s.data.isForeground === true,
        })),
      },
      '[active-viewing] gate check',
    );
  }
  return viewing;
}
