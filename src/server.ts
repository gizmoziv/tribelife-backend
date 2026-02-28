import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';

import { db } from './db';
import {
  messages,
  conversations,
  conversationParticipants,
  userProfiles,
  notifications,
} from './db/schema';

import authRouter from './routes/auth';
import chatRouter from './routes/chat';
import beaconsRouter from './routes/beacons';
import notificationsRouter from './routes/notifications';
import usersRouter from './routes/users';
import { startBeaconMatcherCron } from './jobs/beaconMatcher';
import { sendPushToUser } from './services/pushNotifications';

const app = express();
const httpServer = createServer(app);

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.CLIENT_URL ?? '*',
  credentials: true,
}));
app.use(express.json({ limit: '100kb' }));

const limiter = rateLimit({ windowMs: 60_000, max: 120 });
app.use('/api', limiter);

// ── REST Routes ────────────────────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/chat', chatRouter);
app.use('/api/beacons', beaconsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/users', usersRouter);

app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Socket.io ─────────────────────────────────────────────────────────────
const io = new SocketServer(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL ?? '*',
    credentials: true,
  },
  pingTimeout: 30_000,
  pingInterval: 10_000,
});

// Socket auth middleware — validates JWT and attaches user info
io.use(async (socket, next) => {
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
      })
      .from(userProfiles)
      .where(eq(userProfiles.userId, payload.userId))
      .limit(1);

    socket.data.userId = payload.userId;
    socket.data.timezone = profile[0]?.timezone ?? 'UTC';
    socket.data.handle = profile[0]?.handle ?? 'unknown';
    socket.data.expoPushToken = profile[0]?.expoPushToken ?? null;
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  const userId: number = socket.data.userId;
  const timezone: string = socket.data.timezone;
  const handle: string = socket.data.handle;

  // Auto-join the user's timezone room for location-based chat
  const timezoneRoom = `timezone:${timezone}`;
  socket.join(timezoneRoom);
  socket.join(`user:${userId}`);  // personal room for targeted events

  console.log(`[socket] User ${handle} (${userId}) connected — room: ${timezoneRoom}`);

  // ── Send a message to a timezone room ─────────────────────────────────
  socket.on('room:message', async (data: { content: string }) => {
    const content = data.content?.trim();
    if (!content || content.length > 2000) return;

    // Parse @mentions
    const mentionedHandles = [...content.matchAll(/@([a-zA-Z0-9_]+)/g)].map(
      (m) => m[1].toLowerCase()
    );

    let mentionedUserIds: number[] = [];

    if (mentionedHandles.length > 0) {
      const mentionedProfiles = await db
        .select({ userId: userProfiles.userId, handle: userProfiles.handle })
        .from(userProfiles)
        .where(eq(userProfiles.handle, mentionedHandles[0]));  // simplified for now

      mentionedUserIds = mentionedProfiles.map((p) => p.userId);
    }

    // Persist message
    const [msg] = await db
      .insert(messages)
      .values({
        content,
        senderId: userId,
        roomId: timezoneRoom,
        mentions: mentionedUserIds,
      })
      .returning();

    // Broadcast to room
    const payload = {
      id: msg.id,
      content,
      senderId: userId,
      senderHandle: handle,
      roomId: timezoneRoom,
      createdAt: msg.createdAt,
      mentions: mentionedUserIds,
    };

    io.to(timezoneRoom).emit('room:message', payload);

    // Notify mentioned users
    for (const mentionedId of mentionedUserIds) {
      if (mentionedId === userId) continue;

      await db.insert(notifications).values({
        userId: mentionedId,
        type: 'mention',
        title: `@${handle} mentioned you`,
        body: content.slice(0, 100),
        data: { messageId: msg.id, roomId: timezoneRoom, senderHandle: handle },
      });

      // Emit real-time notification if user is online
      io.to(`user:${mentionedId}`).emit('notification:new', {
        type: 'mention',
        title: `@${handle} mentioned you`,
        body: content.slice(0, 100),
      });

      // Push notification if not in this room
      const mentionedProfile = await db
        .select({ expoPushToken: userProfiles.expoPushToken })
        .from(userProfiles)
        .where(eq(userProfiles.userId, mentionedId))
        .limit(1);

      await sendPushToUser(
        mentionedProfile[0]?.expoPushToken,
        `@${handle} mentioned you`,
        content.slice(0, 100),
        { type: 'mention', roomId: timezoneRoom }
      );
    }
  });

  // ── Send a direct message ─────────────────────────────────────────────
  socket.on('dm:message', async (data: { conversationId: number; content: string }) => {
    const content = data.content?.trim();
    if (!content || content.length > 2000) return;

    // Verify participant
    const participation = await db
      .select()
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, data.conversationId),
          eq(conversationParticipants.userId, userId)
        )
      )
      .limit(1);

    if (participation.length === 0) return;

    // Save message
    const [msg] = await db
      .insert(messages)
      .values({
        content,
        senderId: userId,
        conversationId: data.conversationId,
      })
      .returning();

    // Update conversation timestamp
    await db
      .update(conversations)
      .set({ lastMessageAt: new Date() })
      .where(eq(conversations.id, data.conversationId));

    const msgPayload = {
      id: msg.id,
      content,
      senderId: userId,
      senderHandle: handle,
      conversationId: data.conversationId,
      createdAt: msg.createdAt,
    };

    // Emit to conversation room
    io.to(`conversation:${data.conversationId}`).emit('dm:message', msgPayload);

    // Notify the other participant
    const otherParticipants = await db
      .select({ userId: conversationParticipants.userId })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.conversationId, data.conversationId));

    for (const p of otherParticipants) {
      if (p.userId === userId) continue;

      await db.insert(notifications).values({
        userId: p.userId,
        type: 'new_dm',
        title: `Message from @${handle}`,
        body: content.slice(0, 100),
        data: { conversationId: data.conversationId, senderHandle: handle },
      });

      io.to(`user:${p.userId}`).emit('notification:new', {
        type: 'new_dm',
        title: `Message from @${handle}`,
        body: content.slice(0, 100),
        conversationId: data.conversationId,
      });

      const otherProfile = await db
        .select({ expoPushToken: userProfiles.expoPushToken })
        .from(userProfiles)
        .where(eq(userProfiles.userId, p.userId))
        .limit(1);

      await sendPushToUser(
        otherProfile[0]?.expoPushToken,
        `Message from @${handle}`,
        content.slice(0, 100),
        { type: 'new_dm', conversationId: data.conversationId }
      );
    }
  });

  // ── Join a DM conversation room ───────────────────────────────────────
  socket.on('dm:join', (data: { conversationId: number }) => {
    socket.join(`conversation:${data.conversationId}`);
  });

  // ── Leave a DM conversation room ──────────────────────────────────────
  socket.on('dm:leave', (data: { conversationId: number }) => {
    socket.leave(`conversation:${data.conversationId}`);
  });

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
    console.log(`[socket] User ${handle} (${userId}) disconnected`);
  });
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 4000;

httpServer.listen(PORT, () => {
  console.log(`[server] TribeLife backend running on port ${PORT}`);
  startBeaconMatcherCron();
});

export { io };
