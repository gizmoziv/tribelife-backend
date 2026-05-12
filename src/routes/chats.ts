import { Router, Response } from 'express';
import { eq, and, inArray, desc, sql, notInArray, isNull, ne, gt, or, count } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import {
  conversations,
  conversationParticipants,
  messages,
  users,
  userProfiles,
  blockedUsers,
  globeReadPositions,
} from '../db/schema';
import { requireAuth, AuthRequest } from '../middleware/auth';
import type { ChatsRow, ChatsListResponse } from '../types/chats';

const router = Router();
router.use(requireAuth);

// Town Square is the only auto_join globe room in v1.7 — slug + prefixed
// roomId are hardcoded here to avoid coupling this file to the full
// GLOBE_ROOMS array (per CONTEXT.md canonical_refs: this endpoint does NOT
// call bootstrapAutoJoins or otherwise reach into the membership pipeline).
const TOWN_SQUARE_SLUG = 'town-square';
const TOWN_SQUARE_ROOM_ID = 'globe:town-square';

// ── GET /api/chats — unified Chats list ────────────────────────────────────
// Returns one ordered payload: rows[0] = local_chat row, rows[1] = town_square
// row, then DMs/Groups sorted by unreadCount DESC, lastMessageAt DESC.
// Server owns ordering — mobile renders the array straight into a FlatList
// (CONTEXT.md D-01). Room-row unread counts use globe_read_positions; DM/Group
// unread mirrors the single-aggregate-query pattern from routes/chat.ts:49-73.
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;

  // ── 1. Look up the user's timezone (for the Local Chat row) ────────────
  const [profile] = await db
    .select({ timezone: userProfiles.timezone })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  const userTimezone = profile?.timezone ?? 'UTC';
  const localRoomId = 'timezone:' + userTimezone;

  // ── 2. Look up the user's read positions for BOTH room slugs in one pass ─
  const readPositions = await db
    .select({ roomSlug: globeReadPositions.roomSlug, lastReadAt: globeReadPositions.lastReadAt })
    .from(globeReadPositions)
    .where(and(
      eq(globeReadPositions.userId, userId),
      inArray(globeReadPositions.roomSlug, [userTimezone, TOWN_SQUARE_SLUG]),
    ));
  const readMap = new Map(readPositions.map((r) => [r.roomSlug, r.lastReadAt]));
  const localLastRead = readMap.get(userTimezone) ?? null;
  const townLastRead = readMap.get(TOWN_SQUARE_SLUG) ?? null;

  // ── 3. Local Chat unread count + last message ───────────────────────────
  const localWhere = localLastRead
    ? and(eq(messages.roomId, localRoomId), gt(messages.createdAt, localLastRead), ne(messages.senderId, userId), isNull(messages.deletedAt))
    : and(eq(messages.roomId, localRoomId), ne(messages.senderId, userId), isNull(messages.deletedAt));
  const [localUnread] = await db
    .select({ c: count() })
    .from(messages)
    .where(localWhere)
    .limit(1);
  const [localLastMsg] = await db
    .select({ content: messages.content, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.roomId, localRoomId), isNull(messages.deletedAt)))
    .orderBy(desc(messages.createdAt))
    .limit(1);

  const localChatRow: ChatsRow = {
    type: 'local_chat',
    roomSlug: 'local',
    timezoneIana: userTimezone,
    unreadCount: Math.min(localUnread?.c ?? 0, 99),
    lastMessage: localLastMsg
      ? { preview: localLastMsg.content ?? '', at: (localLastMsg.createdAt as Date).toISOString() }
      : null,
  };

  // ── 4. Town Square unread count + last message ──────────────────────────
  const townWhere = townLastRead
    ? and(eq(messages.roomId, TOWN_SQUARE_ROOM_ID), gt(messages.createdAt, townLastRead), ne(messages.senderId, userId), isNull(messages.deletedAt))
    : and(eq(messages.roomId, TOWN_SQUARE_ROOM_ID), ne(messages.senderId, userId), isNull(messages.deletedAt));
  const [townUnread] = await db
    .select({ c: count() })
    .from(messages)
    .where(townWhere)
    .limit(1);
  const [townLastMsg] = await db
    .select({ content: messages.content, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.roomId, TOWN_SQUARE_ROOM_ID), isNull(messages.deletedAt)))
    .orderBy(desc(messages.createdAt))
    .limit(1);

  const townSquareRow: ChatsRow = {
    type: 'town_square',
    roomSlug: 'town-square',
    unreadCount: Math.min(townUnread?.c ?? 0, 99),
    lastMessage: townLastMsg
      ? { preview: townLastMsg.content ?? '', at: (townLastMsg.createdAt as Date).toISOString() }
      : null,
  };

  // ── 5. DMs + Groups: list of participations + blocked filter ────────────
  const participations = await db
    .select({ conversationId: conversationParticipants.conversationId })
    .from(conversationParticipants)
    .where(and(
      eq(conversationParticipants.userId, userId),
      isNull(conversationParticipants.hiddenAt),
      isNull(conversationParticipants.leftAt),
    ));

  const dmsAndGroups: ChatsRow[] = [];

  if (participations.length > 0) {
    const convIds = participations.map((p) => p.conversationId);

    // ── 5a. Unread aggregate (mirror of chat.ts:49-73) ────────────────────
    const unreadRows = await db
      .select({
        conversationId: messages.conversationId,
        unread: sql<number>`count(*)::int`,
      })
      .from(messages)
      .innerJoin(
        conversationParticipants,
        and(
          eq(conversationParticipants.conversationId, messages.conversationId),
          eq(conversationParticipants.userId, userId),
        ),
      )
      .where(
        and(
          inArray(messages.conversationId, convIds),
          ne(messages.senderId, userId),
          or(
            isNull(conversationParticipants.lastReadAt),
            gt(messages.createdAt, conversationParticipants.lastReadAt),
          ),
        ),
      )
      .groupBy(messages.conversationId);
    const unreadMap = new Map<number, number>(
      unreadRows
        .filter((r) => r.conversationId !== null)
        .map((r) => [r.conversationId as number, Number(r.unread)]),
    );

    // ── 5b. Blocked-user IDs (excluded from DM rows) ──────────────────────
    const blockedRows = await db
      .select({ blockedUserId: blockedUsers.blockedUserId })
      .from(blockedUsers)
      .where(eq(blockedUsers.userId, userId));
    const blockedIds = blockedRows.map((r) => r.blockedUserId);

    // ── 5c. 1-on-1 DMs ────────────────────────────────────────────────────
    const dmResult = await db
      .select({
        conversationId: conversations.id,
        lastMessageAt: conversations.lastMessageAt,
        participantId: conversationParticipants.userId,
        participantHandle: userProfiles.handle,
        participantAvatar: userProfiles.avatarUrl,
      })
      .from(conversations)
      .innerJoin(
        conversationParticipants,
        and(
          eq(conversationParticipants.conversationId, conversations.id),
          sql`${conversationParticipants.userId} != ${userId}`,
        ),
      )
      .innerJoin(users, eq(users.id, conversationParticipants.userId))
      .leftJoin(userProfiles, eq(userProfiles.userId, conversationParticipants.userId))
      .where(
        and(
          inArray(conversations.id, convIds),
          sql`${conversations.isGroup} IS NOT TRUE`,
          ...(blockedIds.length > 0 ? [notInArray(conversationParticipants.userId, blockedIds)] : []),
        ),
      )
      .orderBy(desc(conversations.lastMessageAt));

    // ── 5d. Groups ────────────────────────────────────────────────────────
    const groupResult = await db
      .select({
        conversationId: conversations.id,
        groupName: conversations.groupName,
        groupIconUrl: conversations.groupIconUrl,
        lastMessageAt: conversations.lastMessageAt,
        memberCount: sql<number>`(SELECT count(*)::int FROM conversation_participants WHERE conversation_id = ${conversations.id} AND left_at IS NULL)`,
      })
      .from(conversations)
      .where(
        and(
          inArray(conversations.id, convIds),
          eq(conversations.isGroup, true),
        ),
      )
      .orderBy(desc(conversations.lastMessageAt));

    // ── 5e. Last-message preview for DMs (N+1 — acceptable at <50 convs) ──
    const dmRows: Array<ChatsRow & { lastMessageAt: Date | null }> = await Promise.all(
      dmResult.map(async (row) => {
        const [lastMsg] = await db
          .select({ content: messages.content, createdAt: messages.createdAt })
          .from(messages)
          .where(and(eq(messages.conversationId, row.conversationId), isNull(messages.deletedAt)))
          .orderBy(desc(messages.createdAt))
          .limit(1);
        return {
          type: 'dm' as const,
          conversationId: row.conversationId,
          partner: {
            handle: row.participantHandle ?? '',
            avatarUrl: row.participantAvatar ?? null,
          },
          unreadCount: Math.min(unreadMap.get(row.conversationId) ?? 0, 99),
          lastMessage: lastMsg
            ? { preview: lastMsg.content ?? '', at: (lastMsg.createdAt as Date).toISOString() }
            : null,
          lastMessageAt: row.lastMessageAt ?? null,
        };
      }),
    );

    // ── 5f. Last-message preview for Groups ───────────────────────────────
    const groupRows: Array<ChatsRow & { lastMessageAt: Date | null }> = await Promise.all(
      groupResult.map(async (row) => {
        const [lastMsg] = await db
          .select({ content: messages.content, createdAt: messages.createdAt })
          .from(messages)
          .where(and(eq(messages.conversationId, row.conversationId), isNull(messages.deletedAt)))
          .orderBy(desc(messages.createdAt))
          .limit(1);
        return {
          type: 'group' as const,
          conversationId: row.conversationId,
          name: row.groupName ?? 'Group',
          iconUrl: row.groupIconUrl ?? null,
          memberCount: Number(row.memberCount ?? 0),
          unreadCount: Math.min(unreadMap.get(row.conversationId) ?? 0, 99),
          lastMessage: lastMsg
            ? { preview: lastMsg.content ?? '', at: (lastMsg.createdAt as Date).toISOString() }
            : null,
          lastMessageAt: row.lastMessageAt ?? null,
        };
      }),
    );

    // ── 5g. Merge + sort (unreadCount DESC, lastMessageAt DESC) ───────────
    const merged = [...dmRows, ...groupRows];
    merged.sort((a, b) => {
      if (b.unreadCount !== a.unreadCount) return b.unreadCount - a.unreadCount;
      const aTime = a.lastMessageAt?.getTime() ?? 0;
      const bTime = b.lastMessageAt?.getTime() ?? 0;
      return bTime - aTime;
    });

    // Strip the lastMessageAt helper field — it's not part of the ChatsRow
    // contract (mobile relies on lastMessage.at for display; lastMessageAt
    // was only carried through for the server-side sort).
    for (const row of merged) {
      const { lastMessageAt: _sortKey, ...rowOnly } = row;
      void _sortKey; // consumed by sort comparator above; intentionally unused here
      dmsAndGroups.push(rowOnly);
    }
  }

  // ── 6. Final assembly — server owns the array order ─────────────────────
  const rows: ChatsRow[] = [localChatRow, townSquareRow, ...dmsAndGroups];
  const body: ChatsListResponse = { rows };
  res.json(body);
});

// ── Mark a room (Town Square OR Local Chat) as read ────────────────────────
// Phase 9 R-1: timezone room slugs (e.g. 'America/New_York') are NEVER written
// to globe_read_positions by any existing endpoint — the legacy globe-rooms
// mark-read at PUT /api/globe/rooms/:slug/read rejects them via isValidGlobeRoom().
// This endpoint accepts the BARE slug ('town-square' or an IANA timezone string)
// and upserts the per-user (userId, roomSlug) last_read_at row so the Phase 9
// unread aggregate query in /api/chats can compute a meaningful Local Chat
// unreadCount. Auth-gated; the caller may only mark their own rows read
// (req.user.id is the only user_id ever written).
const roomReadSchema = z.object({
  roomSlug: z.string().min(1).max(100),
});

router.post('/room-read', async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = roomReadSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'roomSlug is required' });
    return;
  }

  const userId = req.user!.id;
  const { roomSlug } = parse.data;
  const now = new Date();

  await db
    .insert(globeReadPositions)
    .values({ userId, roomSlug, lastReadAt: now })
    .onConflictDoUpdate({
      target: [globeReadPositions.userId, globeReadPositions.roomSlug],
      set: { lastReadAt: now },
    });

  res.json({ ok: true });
});

export default router;
