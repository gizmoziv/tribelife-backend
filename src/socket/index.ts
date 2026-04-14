import { Server as SocketServer, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { userProfiles } from '../db/schema';
import logger from '../lib/logger';

const log = logger.child({ module: 'socket' });
import { registerRoomHandlers } from './roomHandler';
import { registerDmHandlers } from './dmHandler';
import { registerGlobeHandlers } from './globeHandler';

// ── CORS Origin Configuration ────────────────────────────────────────────
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim());

if (!allowedOrigins || allowedOrigins.length === 0) {
  if (process.env.NODE_ENV === 'production') {
    log.fatal('ALLOWED_ORIGINS not set in production');
    process.exit(1);
  }
  log.warn('ALLOWED_ORIGINS not set -- allowing all origins (dev mode)');
}

export function createSocketServer(httpServer: HttpServer): SocketServer {
  const io = new SocketServer(httpServer, {
    cors: {
      origin: allowedOrigins && allowedOrigins.length > 0
        ? (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
            if (!origin) return callback(null, true); // Allow mobile/native (no Origin header)
            if (allowedOrigins.includes(origin)) return callback(null, true);
            callback(new Error(`CORS: origin ${origin} not allowed`));
          }
        : true as any,
      credentials: true,
    },
    pingTimeout: 30_000,
    pingInterval: 10_000,
  });

  // Socket auth middleware — validates JWT and attaches user info
  io.use(async (socket: Socket, next: (err?: Error) => void) => {
    const token = socket.handshake.auth.token as string | undefined;

    if (!token) {
      return next(new Error('Authentication required'));
    }

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET!) as { userId: number };
      const profile = await db
        .select({
          userId: userProfiles.userId,
          handle: userProfiles.handle,
          timezone: userProfiles.timezone,
          expoPushToken: userProfiles.expoPushToken,
          createdAt: userProfiles.createdAt,
          avatarUrl: userProfiles.avatarUrl,
        })
        .from(userProfiles)
        .where(eq(userProfiles.userId, payload.userId))
        .limit(1);

      socket.data.userId = payload.userId;
      socket.data.timezone = profile[0]?.timezone ?? 'UTC';
      socket.data.handle = profile[0]?.handle ?? 'unknown';
      socket.data.expoPushToken = profile[0]?.expoPushToken ?? null;
      socket.data.createdAt = profile[0]?.createdAt ?? new Date();
      socket.data.avatarUrl = profile[0]?.avatarUrl ?? null;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const userId: number = socket.data.userId;
    const handle: string = socket.data.handle;

    socket.join(`user:${userId}`);  // personal room for targeted events

    log.info({ userId, handle, timezone: socket.data.timezone }, 'User connected');

    // Register modular handlers
    registerRoomHandlers(io, socket);
    registerDmHandlers(io, socket);
    registerGlobeHandlers(io, socket);

    // ── Typing indicators ─────────────────────────────────────────────────
    socket.on('typing:start', (data: { roomId?: string; conversationId?: number }) => {
      if (data.roomId) {
        socket.to(data.roomId).emit('typing:start', { handle, roomId: data.roomId });
      } else if (data.conversationId) {
        socket.to(`conversation:${data.conversationId}`).emit('typing:start', {
          handle,
          conversationId: data.conversationId,
        });
      }
    });

    socket.on('typing:stop', (data: { roomId?: string; conversationId?: number }) => {
      if (data.roomId) {
        socket.to(data.roomId).emit('typing:stop', { handle });
      } else if (data.conversationId) {
        socket.to(`conversation:${data.conversationId}`).emit('typing:stop', { handle });
      }
    });

    socket.on('disconnect', () => {
      log.info({ userId, handle }, 'User disconnected');
    });
  });

  return io;
}
