import type { Socket } from 'socket.io';

// Shared per-message length cap for the dm / room / globe text send handlers and the
// PATCH /api/chat/messages/:id edit route. It is measured in UTF-16 code units
// (`String.prototype.length` after trim) and is mirrored in
// tribelife-mobile/utils/splitMessage.ts, which splits longer input into several
// messages client-side. Raising it was backward compatible: older clients cap their
// input lower, client-side, so they never send more than they used to.
export const MESSAGE_MAX_LENGTH = 4000;

export const MESSAGE_TOO_LONG_REASON = `Message is too long (limit ${MESSAGE_MAX_LENGTH} characters).`;

export type SendAck = { ok: true; id: number } | { ok: false; reason: string; retryAfterMs?: number };

/**
 * Reply to the sender's optional Socket.IO acknowledgement callback.
 * The ack argument is client-controlled, so it is only called when it is a function.
 */
export function ackSend(ack: unknown, result: SendAck): void {
  if (typeof ack === 'function') ack(result);
}

/**
 * Refuse a send visibly. A sender that supplied an ack gets the reason through it
 * (and no second `message:rejected`, so it shows exactly one alert); a sender
 * without one gets the same `message:rejected` payload as before.
 */
export function rejectSend(socket: Socket, ack: unknown, reason: string | undefined): void {
  if (typeof ack === 'function') {
    ack({ ok: false, reason: reason ?? 'rejected' });
    return;
  }
  socket.emit('message:rejected', { reason });
}
