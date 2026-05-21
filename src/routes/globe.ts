import { Router, Response } from 'express';
import {
  eq,
  ne,
  desc,
  lt,
  and,
  inArray,
  notInArray,
  gt,
  isNull,
  sql,
  count,
} from 'drizzle-orm';
import { z } from 'zod';
import { Server } from 'socket.io';
import { db } from '../db';
import {
  messages,
  users,
  userProfiles,
  blockedUsers,
  globeReadPositions,
  globeRoomMemberships,
  conversations,
  conversationParticipants,
} from '../db/schema';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { attachReactions } from '../utils/attachReactions';
import { attachReplyTo } from '../utils/attachReplyTo';
import {
  GLOBE_ROOMS,
  isValidGlobeRoom,
  getRegionForTimezone,
  getGlobeRoom,
} from '../config/globeRooms';

const router = Router();
router.use(requireAuth);

// ── aroundMessageId query param schema (D-04) ─────────────────────────────────
const aroundMessageSchema = z.object({
  aroundMessageId: z.coerce.number().int().positive().optional(),
  before: z.coerce.number().int().min(0).max(50).optional().default(25),
  after: z.coerce.number().int().min(0).max(50).optional().default(25),
});

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

  // Phase 11 D-03: derive isMember per room via a single membership query
  const memberships = await db
    .select({ roomSlug: globeRoomMemberships.roomSlug })
    .from(globeRoomMemberships)
    .where(eq(globeRoomMemberships.userId, userId));
  const memberSlugs = new Set(memberships.map((m) => m.roomSlug));

  const rooms = await Promise.all(
    GLOBE_ROOMS.map(async (room) => {
      const realCount = io.sockets.adapter.rooms.get(room.roomId)?.size ?? 0;
      const participantCount =
        realCount > 0 ? realCount : Math.floor(Math.random() * 10) + 1;

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
        kind: 'globe_room' as const,
        slug: room.slug,
        displayName: room.displayName,
        participantCount,
        lastMessage: lastMsg
          ? {
              content: lastMsg.content,
              createdAt: lastMsg.createdAt,
              senderHandle: lastMsg.senderHandle,
            }
          : null,
        isSuggested: room.slug === suggestedRegion,
        isGlobal: room.isGlobal,
        sortOrder: room.sortOrder,
        welcomeMessage: room.welcomeMessage,
        // Phase 11 D-03 + D-05:
        isMember: memberSlugs.has(room.slug),
        autoJoin: room.autoJoin,
      };
    }),
  );

  // Phase 11 D-06: server-owned ordering — user's region first (per
  // isSuggested), then remaining rooms by sortOrder ASC. Town Square is
  // included in the response (existing contract); the mobile screen
  // continues to filter it out client-side via the existing
  // `globe/index.tsx:154` line.
  rooms.sort((a, b) => {
    const aIsUserRegion = a.isSuggested ? 1 : 0;
    const bIsUserRegion = b.isSuggested ? 1 : 0;
    if (aIsUserRegion !== bIsUserRegion) return bIsUserRegion - aIsUserRegion;
    return a.sortOrder - b.sortOrder;
  });

  // Phase 12 D-04 + D-08: public-group UNION — appended after globe rooms
  // (ordered by lastMessageAt DESC per D-08). Filters: isPublic=true,
  // archivedAt IS NULL. LIMIT 50 safety ceiling.
  const publicGroupsRaw = await db
    .select({
      conversationId: conversations.id,
      name: conversations.groupName,
      iconUrl: conversations.groupIconUrl,
      inviteSlug: conversations.inviteSlug,
      lastMessageAt: conversations.lastMessageAt,
      memberCount: sql<number>`(
        SELECT count(*)::int FROM conversation_participants
        WHERE conversation_id = ${conversations.id} AND left_at IS NULL
      )`,
    })
    .from(conversations)
    .where(and(
      eq(conversations.isGroup, true),
      eq(conversations.isPublic, true),
      isNull(conversations.archivedAt),
    ))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(50);

  // Derive isMember via a separate participant lookup — mirrors the globe-room
  // memberships pattern above. Avoids the inline-EXISTS userId binding issue
  // and keeps the query path consistent across both row kinds.
  const publicGroupIds = publicGroupsRaw.map((r) => r.conversationId);
  const memberConversationIds = publicGroupIds.length
    ? await db
        .select({ conversationId: conversationParticipants.conversationId })
        .from(conversationParticipants)
        .where(and(
          eq(conversationParticipants.userId, userId),
          isNull(conversationParticipants.leftAt),
          inArray(conversationParticipants.conversationId, publicGroupIds),
        ))
    : [];
  const memberGroupIdSet = new Set(memberConversationIds.map((m) => m.conversationId));

  // Last-message preview per group (N+1 — mirrors chats.ts group N+1 pattern)
  const publicGroupRows = await Promise.all(
    publicGroupsRaw.map(async (row) => {
      const [lastMsg] = await db
        .select({
          content: messages.content,
          createdAt: messages.createdAt,
          senderHandle: userProfiles.handle,
        })
        .from(messages)
        .leftJoin(userProfiles, eq(userProfiles.userId, messages.senderId))
        .where(and(eq(messages.conversationId, row.conversationId), isNull(messages.deletedAt)))
        .orderBy(desc(messages.createdAt))
        .limit(1);
      return {
        kind: 'group' as const,
        conversationId: row.conversationId,
        name: row.name ?? 'Group',
        iconUrl: row.iconUrl ?? null,
        inviteSlug: row.inviteSlug ?? '',
        memberCount: Number(row.memberCount ?? 0),
        isMember: memberGroupIdSet.has(row.conversationId),
        lastMessage: lastMsg
          ? {
              content: lastMsg.content,
              createdAt: (lastMsg.createdAt as Date).toISOString(),
              senderHandle: lastMsg.senderHandle ?? '',
            }
          : null,
      };
    }),
  );

  res.json({ rooms: [...rooms, ...publicGroupRows] });
});

// ── Get paginated message history for a Globe room ──────────────────────────
router.get(
  '/rooms/:slug/messages',
  async (req: AuthRequest, res: Response): Promise<void> => {
    const slug = req.params.slug as string;
    if (!isValidGlobeRoom(slug)) {
      res.status(404).json({ error: 'Room not found' });
      return;
    }

    const userId = req.user!.id;
    const roomId = 'globe:' + slug;

    // Parse aroundMessageId params — validation error is cheapest to return
    const aroundParse = aroundMessageSchema.safeParse(req.query);
    if (!aroundParse.success) {
      res.status(400).json({ error: aroundParse.error.errors[0].message });
      return;
    }
    const { aroundMessageId, before: beforeCount, after: afterCount } = aroundParse.data;

    const cursor = req.query.before && !aroundMessageId
      ? new Date(req.query.before as string)
      : undefined;
    const limit = Math.min(parseInt((req.query.limit as string) ?? '50'), 100);

    // Get blocked user IDs to exclude their messages
    const blockedRows = await db
      .select({ blockedUserId: blockedUsers.blockedUserId })
      .from(blockedUsers)
      .where(eq(blockedUsers.userId, userId));
    const blockedIds = blockedRows.map((r) => r.blockedUserId);

    // ── aroundMessageId path (D-04) ──────────────────────────────────────────
    if (aroundMessageId !== undefined) {
      // Fetch target row — must exist, belong to this globe room, and not be deleted
      const [target] = await db
        .select({
          id: messages.id,
          roomId: messages.roomId,
          createdAt: messages.createdAt,
          deletedAt: messages.deletedAt,
        })
        .from(messages)
        .where(eq(messages.id, aroundMessageId))
        .limit(1);

      // T-14-03-I-grinding: mismatch or missing → 404
      if (
        !target ||
        target.roomId !== roomId ||
        target.deletedAt !== null
      ) {
        res.status(404).json({ error: 'message not found' });
        return;
      }

      const msgSelect = {
        id: messages.id,
        content: messages.content,
        createdAt: messages.createdAt,
        senderId: messages.senderId,
        senderName: users.name,
        senderHandle: userProfiles.handle,
        senderAvatar: userProfiles.avatarUrl,
        mentions: messages.mentions,
        mediaUrls: messages.mediaUrls,
      } as const;

      const targetCreatedAt = target.createdAt as Date;
      const targetId = target.id;

      // Build blocked-sender exclusion for before/after queries
      const blockedClauseOlder = blockedIds.length > 0
        ? and(
            eq(messages.roomId, roomId),
            isNull(messages.deletedAt),
            sql`(${messages.createdAt}, ${messages.id}) < (${targetCreatedAt.toISOString()}::timestamptz, ${targetId})`,
            notInArray(messages.senderId, blockedIds),
          )
        : and(
            eq(messages.roomId, roomId),
            isNull(messages.deletedAt),
            sql`(${messages.createdAt}, ${messages.id}) < (${targetCreatedAt.toISOString()}::timestamptz, ${targetId})`,
          );

      const blockedClauseNewer = blockedIds.length > 0
        ? and(
            eq(messages.roomId, roomId),
            isNull(messages.deletedAt),
            sql`(${messages.createdAt}, ${messages.id}) > (${targetCreatedAt.toISOString()}::timestamptz, ${targetId})`,
            notInArray(messages.senderId, blockedIds),
          )
        : and(
            eq(messages.roomId, roomId),
            isNull(messages.deletedAt),
            sql`(${messages.createdAt}, ${messages.id}) > (${targetCreatedAt.toISOString()}::timestamptz, ${targetId})`,
          );

      const [olderRows, newerRows] = await Promise.all([
        db
          .select(msgSelect)
          .from(messages)
          .leftJoin(users, eq(users.id, messages.senderId))
          .leftJoin(userProfiles, eq(userProfiles.userId, messages.senderId))
          .where(blockedClauseOlder)
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(beforeCount),
        db
          .select(msgSelect)
          .from(messages)
          .leftJoin(users, eq(users.id, messages.senderId))
          .leftJoin(userProfiles, eq(userProfiles.userId, messages.senderId))
          .where(blockedClauseNewer)
          .orderBy(messages.createdAt, messages.id)
          .limit(afterCount),
      ]);

      // Fetch target in full projection shape
      const [targetFull] = await db
        .select(msgSelect)
        .from(messages)
        .leftJoin(users, eq(users.id, messages.senderId))
        .leftJoin(userProfiles, eq(userProfiles.userId, messages.senderId))
        .where(eq(messages.id, aroundMessageId))
        .limit(1);

      const window = [...olderRows.reverse(), targetFull, ...newerRows];
      const withReactions = await attachReactions(window, userId);
      const withReplies = await attachReplyTo(withReactions);
      res.json({ messages: withReplies });
      return;
    }

    // ── Existing pagination path (unchanged) ────────────────────────────────
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
    res.json({
      messages: withReplies.reverse(),
      hasMore: rows.length === limit,
    });
  },
);

// ── Mark all Globe rooms as read ──────────────────────────────────────────
// Used by the bell's Mentions tab "Mark read" action so clearing mention
// notifications also clears the corresponding Globe tab unread signal.
router.put(
  '/rooms/mark-all-read',
  async (req: AuthRequest, res: Response): Promise<void> => {
    const userId = req.user!.id;
    const now = new Date();

    await Promise.all(
      GLOBE_ROOMS.map((room) =>
        db
          .insert(globeReadPositions)
          .values({ userId, roomSlug: room.slug, lastReadAt: now })
          .onConflictDoUpdate({
            target: [globeReadPositions.userId, globeReadPositions.roomSlug],
            set: { lastReadAt: now },
          }),
      ),
    );

    res.json({ ok: true });
  },
);

// ── Mark a Globe room as read ──────────────────────────────────────────────
router.put(
  '/rooms/:slug/read',
  async (req: AuthRequest, res: Response): Promise<void> => {
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
  },
);

// ── Get unread counts for all Globe rooms ──────────────────────────────────
router.get(
  '/unread',
  async (req: AuthRequest, res: Response): Promise<void> => {
    const userId = req.user!.id;

    // Get all read positions for this user
    const readPositions = await db
      .select({
        roomSlug: globeReadPositions.roomSlug,
        lastReadAt: globeReadPositions.lastReadAt,
      })
      .from(globeReadPositions)
      .where(eq(globeReadPositions.userId, userId));

    const readMap = new Map(
      readPositions.map((r) => [r.roomSlug, r.lastReadAt]),
    );

    // Count unread messages per room in parallel
    const unread: Record<string, number> = {};

    await Promise.all(
      GLOBE_ROOMS.map(async (room) => {
        const lastRead = readMap.get(room.slug);
        const whereClause = lastRead
          ? and(
              eq(messages.roomId, room.roomId),
              gt(messages.createdAt, lastRead),
              ne(messages.senderId, userId),
            )
          : and(
              eq(messages.roomId, room.roomId),
              ne(messages.senderId, userId),
            );

        const [result] = await db
          .select({ count: count() })
          .from(messages)
          .where(whereClause)
          .limit(1);

        unread[room.slug] = Math.min(result?.count ?? 0, 99);
      }),
    );

    res.json({ unread });
  },
);

// ── Phase 11 D-05: Join a Globe room ──────────────────────────────────────
// Idempotent — re-running with the same (userId, roomSlug) is a no-op via
// onConflictDoNothing. Slug validation via isValidGlobeRoom. No capability
// gate (D-10 — Globe-room membership is not a capability axis). No
// caps:invalidated emit. requireAuth covered at router level (line 12).
router.post(
  '/rooms/:slug/join',
  async (req: AuthRequest, res: Response): Promise<void> => {
    const slug = req.params.slug as string;
    if (!isValidGlobeRoom(slug)) {
      res.status(404).json({ error: 'Unknown globe room' });
      return;
    }

    const userId = req.user!.id;
    await db
      .insert(globeRoomMemberships)
      .values({ userId, roomSlug: slug })
      .onConflictDoNothing({
        target: [globeRoomMemberships.userId, globeRoomMemberships.roomSlug],
      });

    res.json({ ok: true, isMember: true });
  },
);

// ── Phase 11 D-05 + D-08: Leave a Globe room ──────────────────────────────
// Slug validation + autoJoin gate. autoJoin=true rooms (Town Square only in
// v1.7) CANNOT be left — returns 422. Regular regional rooms remove the
// membership row but PRESERVE the corresponding globe_read_positions row
// (D-08 — keeps read position on rejoin; cheap to keep). No
// caps:invalidated emit (D-10).
router.delete(
  '/rooms/:slug/join',
  async (req: AuthRequest, res: Response): Promise<void> => {
    const slug = req.params.slug as string;
    if (!isValidGlobeRoom(slug)) {
      res.status(404).json({ error: 'Unknown globe room' });
      return;
    }

    const room = getGlobeRoom(slug);
    if (room?.autoJoin) {
      res.status(422).json({ error: 'Cannot leave an auto-join community' });
      return;
    }

    const userId = req.user!.id;
    await db
      .delete(globeRoomMemberships)
      .where(
        and(
          eq(globeRoomMemberships.userId, userId),
          eq(globeRoomMemberships.roomSlug, slug),
        ),
      );

    res.json({ ok: true, isMember: false });
  },
);

export default router;
