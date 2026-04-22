// Tiny module-level singleton so background jobs (cron, queue workers) can
// emit Socket.IO events without having the Server instance threaded through
// every call. Set once in server.ts after createSocketServer; getIO() returns
// null before bootstrap completes (callers should null-check).
import type { Server } from 'socket.io';

let io: Server | null = null;

export function setIO(server: Server): void {
  io = server;
}

export function getIO(): Server | null {
  return io;
}
