import { Server as SocketServer, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import {
  userProfiles,
  globeRoomMemberships,
  organizationMemberships,
} from '../db/schema';
import { isValidTimezoneRoom, getZoneForTimezone } from '../config/timezoneZones';
import logger from '../lib/logger';
import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';

const log = logger.child({ module: 'socket' });
const redisLog = logger.child({ module: 'socket.redis' });
import { registerRoomHandlers } from './roomHandler';
import { registerDmHandlers } from './dmHandler';
import { registerGlobeHandlers } from './globeHandler';
import { canonicalViewingKey } from './activeViewing';

// ── CORS Origin Configuration ────────────────────────────────────────────
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map((o) =>
  o.trim(),
);

if (!allowedOrigins || allowedOrigins.length === 0) {
  if (process.env.NODE_ENV === 'production') {
    log.fatal('ALLOWED_ORIGINS not set in production');
    process.exit(1);
  }
  log.warn('ALLOWED_ORIGINS not set -- allowing all origins (dev mode)');
}

// ── Redis Adapter Configuration ──────────────────────────────────────────
const redisUrl =
  process.env.NODE_ENV === 'production'
    ? process.env.REDIS_URL
    : process.env.REDIS_URL_DEV;

if (!redisUrl) {
  if (process.env.NODE_ENV === 'production') {
    redisLog.fatal(
      { event: 'redis_url_missing' },
      'REDIS_URL not set in production',
    );
    process.exit(1);
  }
  redisLog.warn(
    { event: 'redis_adapter_disabled' },
    'Redis adapter disabled — dev mode, single-instance only',
  );
} else if (
  process.env.NODE_ENV === 'production' &&
  !redisUrl.startsWith('rediss://')
) {
  redisLog.fatal(
    { event: 'redis_url_insecure' },
    'Production requires rediss:// URL for TLS',
  );
  process.exit(1);
}

export async function createSocketServer(
  httpServer: HttpServer,
): Promise<SocketServer> {
  const io = new SocketServer(httpServer, {
    cors: {
      origin:
        allowedOrigins && allowedOrigins.length > 0
          ? (
              origin: string | undefined,
              callback: (err: Error | null, allow?: boolean) => void,
            ) => {
              if (!origin) return callback(null, true); // Allow mobile/native (no Origin header)
              if (allowedOrigins.includes(origin)) return callback(null, true);
              callback(new Error(`CORS: origin ${origin} not allowed`));
            }
          : (true as any),
      credentials: true,
    },
    // TEMPORARY: allow polling fallback so pre-Feb-28 mobile builds can connect.
    // Revert to ['websocket'] once v1.4 mobile (with websocket-only client) is
    // the minimum deployed version. Polling-only clients require sticky sessions
    // for horizontal scaling; safe while instance_count=1.
    transports: ['polling', 'websocket'],
    pingTimeout: 30_000,
    pingInterval: 10_000,
  });

  // ── Redis adapter ─────────────────────────────────────────────────────
  if (redisUrl) {
    function redactRedisUrl(url: string): string {
      try {
        const u = new URL(url);
        u.password = '***';
        return u.toString();
      } catch {
        return '[invalid-url]';
      }
    }

    const pub = createClient({
      url: redisUrl,
      socket: {
        keepAlive: 30_000,
        reconnectStrategy: (retries: number) => {
          if (retries > 10) {
            return new Error('Redis reconnect limit exceeded');
          }
          return Math.min(Math.pow(2, retries) * 50, 2000);
        },
      },
    });
    const sub = pub.duplicate();

    // MANDATORY: register error listeners BEFORE connect() — unlistened
    // errors crash Node.js. duplicate() does NOT copy listeners — register
    // on both clients independently.
    pub.on('error', (err: Error) => {
      if (!pub.isOpen) {
        redisLog.fatal(
          { err, event: 'redis_terminal_failure' },
          'Redis connection failed',
        );
        process.exit(1);
      }
      redisLog.error(
        { err, event: 'redis_pub_error' },
        'Redis pub client error',
      );
    });
    sub.on('error', (err: Error) => {
      if (!sub.isOpen) {
        redisLog.fatal(
          { err, event: 'redis_terminal_failure' },
          'Redis connection failed',
        );
        process.exit(1);
      }
      redisLog.error(
        { err, event: 'redis_sub_error' },
        'Redis sub client error',
      );
    });
    pub.on('reconnecting', () =>
      redisLog.warn(
        { event: 'redis_pub_reconnecting' },
        'Redis pub reconnecting',
      ),
    );
    sub.on('reconnecting', () =>
      redisLog.warn(
        { event: 'redis_sub_reconnecting' },
        'Redis sub reconnecting',
      ),
    );
    pub.on('ready', () =>
      redisLog.info({ event: 'redis_pub_ready' }, 'Redis pub ready'),
    );
    sub.on('ready', () =>
      redisLog.info({ event: 'redis_sub_ready' }, 'Redis sub ready'),
    );
    pub.on('end', () =>
      redisLog.warn({ event: 'redis_pub_end' }, 'Redis pub connection ended'),
    );
    sub.on('end', () =>
      redisLog.warn({ event: 'redis_sub_end' }, 'Redis sub connection ended'),
    );

    await pub.connect();
    await sub.connect();

    io.adapter(
      createAdapter(pub, sub, {
        key: `tribelife:${process.env.NODE_ENV ?? 'development'}:socket`,
      }),
    );

    redisLog.info(
      { event: 'redis_adapter_ready', url: redactRedisUrl(redisUrl) },
      'Redis adapter ready',
    );
  }

  // Socket auth middleware — validates JWT and attaches user info
  io.use(async (socket: Socket, next: (err?: Error) => void) => {
    const token = socket.handshake.auth.token as string | undefined;

    if (!token) {
      return next(new Error('Authentication required'));
    }

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET!) as {
        userId: number;
      };
      const profile = await db
        .select({
          userId: userProfiles.userId,
          handle: userProfiles.handle,
          timezone: userProfiles.timezone,
          expoPushToken: userProfiles.expoPushToken,
          createdAt: userProfiles.createdAt,
          avatarUrl: userProfiles.avatarUrl,
          // Phase 15 D-08: cap fields fetched at auth time so the auto-join
          // loop below can filter non-native timezone subscriptions without
          // a second round-trip.
          isPremium: userProfiles.isPremium,
          premiumExpiresAt: userProfiles.premiumExpiresAt,
        })
        .from(userProfiles)
        .where(eq(userProfiles.userId, payload.userId))
        .limit(1);

      // Phase 15 D-08: org_admin tier counts as paid for non-native timezone
      // access — single-source predicate `callerCanAccessNonNativeTimezone`
      // uses BOTH isPremium and tier='org_admin'.
      const orgAdminRows = await db
        .select({ id: organizationMemberships.id })
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.userId, payload.userId),
            eq(organizationMemberships.role, 'admin'),
          ),
        )
        .limit(1);
      const isOrgAdmin = orgAdminRows.length > 0;

      socket.data.userId = payload.userId;
      socket.data.timezone = profile[0]?.timezone ?? 'UTC';
      socket.data.handle = profile[0]?.handle ?? 'unknown';
      socket.data.expoPushToken = profile[0]?.expoPushToken ?? null;
      socket.data.createdAt = profile[0]?.createdAt ?? new Date();
      socket.data.avatarUrl = profile[0]?.avatarUrl ?? null;
      socket.data.isPremium = profile[0]?.isPremium ?? false;
      socket.data.premiumExpiresAt = profile[0]?.premiumExpiresAt ?? null;
      socket.data.isOrgAdmin = isOrgAdmin;
      // 260621-un7: per-socket active-viewing state. `activeRoomKey` is the
      // canonical roomKey the socket is currently viewing (null = none);
      // `isForeground` defaults to true on connect (a freshly-connected socket
      // is foregrounded). Mutated by the viewing:* / app:* handlers below and
      // read by isUserActivelyViewing() to gate notifications.
      socket.data.activeRoomKey = null;
      socket.data.isForeground = true;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', async (socket: Socket) => {
    const userId: number = socket.data.userId;
    const handle: string = socket.data.handle;

    socket.join(`user:${userId}`); // personal room for targeted events
    socket.join('globe-signals'); // fan-out room for globe unread signals — every connected user joins so they can increment tab badges for rooms they haven't explicitly entered

    // LIVE-01 (D-10): auto-subscribe to all globe rooms the user is a member of.
    // Sits AFTER globe-signals join and BEFORE registerXHandlers so that the
    // socket is subscribed before any handler emits into those rooms.
    // socket.join is idempotent (socket.io 4.8.1) — re-joining town-square is a no-op.
    try {
      const regionMemberships = await db
        .select({ roomSlug: globeRoomMemberships.roomSlug })
        .from(globeRoomMemberships)
        .where(eq(globeRoomMemberships.userId, userId));
      // Phase 15 D-08: precompute per-socket gate inputs once.
      const isPremiumActive =
        socket.data.isPremium &&
        (!socket.data.premiumExpiresAt ||
          (socket.data.premiumExpiresAt as Date) > new Date());
      const callerNativeSlug = getZoneForTimezone(socket.data.timezone);

      for (const m of regionMemberships) {
        if (isValidTimezoneRoom(m.roomSlug)) {
          // Native timezone room: primary subscription is `timezone:<slug>`,
          // joined by roomHandler.ts via Plan 15-01's write-path patch. The
          // `globe-feed:<native-slug>` fan-out is redundant for native zone
          // (Chats list updates via chat:notification already).
          if (m.roomSlug === callerNativeSlug) continue;
          // D-08 cap filter: free/org_member callers do NOT subscribe to
          // non-native timezone feed rooms even if a membership row exists.
          if (!isPremiumActive && !socket.data.isOrgAdmin) continue;
        }
        // Phase 14 Bug 3 fix: auto-join the FEED room ('globe-feed:<slug>'),
        // not the presence room ('globe:<slug>'). The presence room is for
        // active-viewer participant counting + typing indicators and is
        // joined/left as the user navigates in/out of the globe room screen.
        // The feed room is the broadcast subscription that keeps the Chats
        // list lastMessage updating even after the user leaves the screen.
        socket.join('globe-feed:' + m.roomSlug);
      }
      log.info(
        { userId, roomCount: regionMemberships.length },
        '[live] socket joined regional rooms',
      );
    } catch (err) {
      log.error(
        { userId, err: String(err) },
        '[live] failed to auto-join regional rooms',
      );
      // degraded — socket connection continues normally without auto-subscribe
    }

    log.info(
      { userId, handle, timezone: socket.data.timezone },
      'User connected',
    );

    // Register modular handlers
    registerRoomHandlers(io, socket);
    registerDmHandlers(io, socket);
    registerGlobeHandlers(io, socket);

    // ── Active-viewing + foreground signals (260621-un7) ───────────────────
    // Mobile signals which room this socket is viewing (on screen focus/blur)
    // and whether the app is foregrounded (single AppState listener). The
    // backend gates push/bell/unread for the actively-viewed room using this
    // per-socket state. All keys are canonicalized so timezone:<slug> and
    // globe:<slug> of one zone share a single viewing identity.
    socket.on('viewing:set', (data: { roomKey?: string }) => {
      const raw = data?.roomKey;
      if (typeof raw !== 'string' || raw.length === 0) return; // no-op on invalid
      socket.data.activeRoomKey = canonicalViewingKey(raw);
    });

    socket.on('viewing:clear', () => {
      socket.data.activeRoomKey = null;
    });

    socket.on('app:foreground', () => {
      socket.data.isForeground = true;
    });

    socket.on('app:background', () => {
      // Background means not viewing — clearing activeRoomKey here is what makes
      // push resume immediately even if the chat screen stays mounted.
      socket.data.isForeground = false;
      socket.data.activeRoomKey = null;
    });

    // ── Typing indicators ─────────────────────────────────────────────────
    socket.on(
      'typing:start',
      (data: { roomId?: string; conversationId?: number }) => {
        if (data.roomId) {
          socket
            .to(data.roomId)
            .emit('typing:start', { handle, roomId: data.roomId });
        } else if (data.conversationId) {
          socket
            .to(`conversation:${data.conversationId}`)
            .emit('typing:start', {
              handle,
              conversationId: data.conversationId,
            });
        }
      },
    );

    socket.on(
      'typing:stop',
      (data: { roomId?: string; conversationId?: number }) => {
        if (data.roomId) {
          socket.to(data.roomId).emit('typing:stop', { handle });
        } else if (data.conversationId) {
          socket
            .to(`conversation:${data.conversationId}`)
            .emit('typing:stop', { handle });
        }
      },
    );

    socket.on('disconnect', () => {
      log.info({ userId, handle }, 'User disconnected');
    });
  });

  return io;
}
