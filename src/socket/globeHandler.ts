import { Server, Socket } from 'socket.io';
import { checkRateLimit } from './rateLimit';

// Globe room events — implemented in Phase 3
// Events: globe:message, globe:join, globe:leave, globe:typing

export function registerGlobeHandlers(io: Server, socket: Socket): void {
  // Phase 3: Globe room event handlers will be registered here
  // Rate limiting via checkRateLimit(userId, roomId) is available
  void io;
  void socket;
  void checkRateLimit;
}
