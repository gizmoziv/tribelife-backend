import { Router, Response } from 'express';
import { eq, ne, desc, lt, and, notInArray, gt, isNull, sql, count } from 'drizzle-orm';
import { Server } from 'socket.io';
import { db } from '../db';
import { messages, users, userProfiles, blockedUsers, globeReadPositions } from '../db/schema';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { attachReactions } from '../utils/attachReactions';
import { attachReplyTo } from '../utils/attachReplyTo';
import { GLOBE_ROOMS, isValidGlobeRoom, getRegionForTimezone } from '../config/globeRooms';

const router = Router();
router.use(requireAuth);

// ── List all Globe rooms with live metadata ─────────────────────────────────
router.get('/rooms', async (req: AuthRequest, res: Response): Promise<void> => {
  const io = req.app.get('io') as Server;
  const userId = req.user!.id;

  // Get user's timezone for auto-suggestion
  const [profile] = await db
    .select({ timezone: userProfiles.timezone })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);

  const suggestedRegion = getRegionForTimezone(profile?.timezone ?? 'UTC');

  const rooms = await Promise.all(
    GLOBE_ROOMS.map(async (room) => {
      const realCount = io.sockets.adapter.rooms.get(room.roomId)?.size ?? 0;
      const participantCount = realCount > 0 ? realCount : Math.floor(Math.random() * 10) + 1;

      // Get last message preview
      const [lastMsg] = await db
        .select({
          content: messages.content,
          createdAt: messages.createdAt,
          senderHandle: userProfiles.handle,
        })
        .from(messages)
        .leftJoin(userProfiles, eq(userProfiles.userId, messages.senderId))
        .where(eq(messages.roomId, room.roomId))
        .orderBy(desc(messages.createdAt))
        .limit(1);

      return {
        slug: room.slug,
        displayName: room.displayName,
        description: room.description,
        participantCount,
        lastMessage: lastMsg
          ? { content: lastMsg.content, createdAt: lastMsg.createdAt, senderHandle: lastMsg.senderHandle }
          : null,
        isSuggested: room.slug === suggestedRegion,
        isGlobal: room.isGlobal,
        sortOrder: room.sortOrder,
        welcomeMessage: room.welcomeMessage,
      };
    })
  );

  res.json({ rooms });
});

// ── Get paginated message history for a Globe room ──────────────────────────
router.get('/rooms/:slug/messages', async (req: AuthRequest, res: Response): Promise<void> => {
  const slug = req.params.slug as string;
  if (!isValidGlobeRoom(slug)) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }

  const userId = req.user!.id;
  const roomId = 'globe:' + slug;
  const cursor = req.query.before ? new Date(req.query.before as string) : undefined;
  const limit = Math.min(parseInt(req.query.limit as string ?? '50'), 100);

  // Get blocked user IDs to exclude their messages
  const blockedRows = await db
    .select({ blockedUserId: blockedUsers.blockedUserId })
    .from(blockedUsers)
    .where(eq(blockedUsers.userId, userId));
  const blockedIds = blockedRows.map((r) => r.blockedUserId);

  const baseWhere = cursor
    ? and(eq(messages.roomId, roomId), lt(messages.createdAt, cursor))
    : eq(messages.roomId, roomId);

  const whereClause =
    blockedIds.length > 0 && messages.senderId !== null
      ? and(baseWhere, notInArray(messages.senderId, blockedIds))
      : baseWhere;

  const rows = await db
    .select({
      id: messages.id,
      content: messages.content,
      createdAt: messages.createdAt,
      senderId: messages.senderId,
      senderName: users.name,
      senderHandle: userProfiles.handle,
      senderAvatar: userProfiles.avatarUrl,
      mentions: messages.mentions,
      mediaUrls: messages.mediaUrls,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.senderId))
    .leftJoin(userProfiles, eq(userProfiles.userId, messages.senderId))
    .where(whereClause)
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  const withReactions = await attachReactions(rows, userId);
  const withReplies = await attachReplyTo(withReactions);
  res.json({ messages: withReplies.reverse(), hasMore: rows.length === limit });
});

// ── Mark a Globe room as read ──────────────────────────────────────────────
router.put('/rooms/:slug/read', async (req: AuthRequest, res: Response): Promise<void> => {
  const slug = req.params.slug as string;
  if (!isValidGlobeRoom(slug)) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }

  const userId = req.user!.id;

  await db
    .insert(globeReadPositions)
    .values({ userId, roomSlug: slug, lastReadAt: new Date() })
    .onConflictDoUpdate({
      target: [globeReadPositions.userId, globeReadPositions.roomSlug],
      set: { lastReadAt: new Date() },
    });

  res.json({ ok: true });
});

// ── Get unread counts for all Globe rooms ──────────────────────────────────
router.get('/unread', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;

  // Get all read positions for this user
  const readPositions = await db
    .select({ roomSlug: globeReadPositions.roomSlug, lastReadAt: globeReadPositions.lastReadAt })
    .from(globeReadPositions)
    .where(eq(globeReadPositions.userId, userId));

  const readMap = new Map(readPositions.map((r) => [r.roomSlug, r.lastReadAt]));

  // Count unread messages per room in parallel
  const unread: Record<string, number> = {};

  await Promise.all(
    GLOBE_ROOMS.map(async (room) => {
      const lastRead = readMap.get(room.slug);
      const whereClause = lastRead
        ? and(eq(messages.roomId, room.roomId), gt(messages.createdAt, lastRead), ne(messages.senderId, userId))
        : and(eq(messages.roomId, room.roomId), ne(messages.senderId, userId));

      const [result] = await db
        .select({ count: count() })
        .from(messages)
        .where(whereClause)
        .limit(1);

      unread[room.slug] = Math.min(result?.count ?? 0, 99);
    })
  );

  res.json({ unread });
});

export default router;
