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
  globeRoomMemberships,
} from '../db/schema';
import { requireAuth, AuthRequest } from '../middleware/auth';
import type { ChatsRow, ChatsListResponse } from '../types/chats';
import { GLOBE_ROOMS, isValidGlobeRoom } from '../config/globeRooms';
import {
  getZoneForTimezone,
  getTimezoneZone,
  isValidTimezoneRoom,
} from '../config/timezoneZones';
import {
  callerCanAccessNonNativeTimezone,
  timezoneRoomId,
} from '../lib/timezoneRoomAccess';
import { getCapabilities } from '../middleware/capabilities';

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
  // Phase 15 D-08: request-scoped caps memo — re-used in section 4b for the
  // D-08 non-native timezone-room filter. getCapabilities() is idempotent
  // and memoizes onto req._capabilities.
  const caps = await getCapabilities(req);

  // ── 1. Look up the user's timezone (for the Local Chat row) ────────────
  const [profile] = await db
    .select({ timezone: userProfiles.timezone })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  const userTimezone = profile?.timezone ?? 'UTC';
  // Phase 15 (D-01): Local Chat room id is keyed by the canonical zone slug
  // (e.g. 'eastern-time'), NOT the raw IANA. NY + Detroit + Toronto all share
  // the same consolidated room post-migration 0019. The localChatRow's
  // `timezoneIana` field below intentionally STAYS raw IANA — it's a mobile
  // routing hint, not a room key (RESEARCH §I5).
  const localZoneSlug = getZoneForTimezone(userTimezone);
  const localRoomId = 'timezone:' + localZoneSlug;
  // D-05 dedup pivot for section 4b: a membership row whose slug equals the
  // caller's CURRENT native zone is suppressed from the joined-non-native
  // list (row stays in DB — protects ping-pong profile-tz moves).
  const callerNativeSlug = localZoneSlug;

  // ── 2. Look up the user's read positions for BOTH room slugs in one pass ─
  // Phase 15: globe_read_positions.room_slug now stores the BARE zone slug
  // (e.g. 'eastern-time'), not the IANA — migration 0019 remapped historical
  // rows; new writes from /api/chats/room-read use whatever the mobile client
  // passes, which from Phase 15 onward is the bare zone slug.
  const readPositions = await db
    .select({ roomSlug: globeReadPositions.roomSlug, lastReadAt: globeReadPositions.lastReadAt })
    .from(globeReadPositions)
    .where(and(
      eq(globeReadPositions.userId, userId),
      inArray(globeReadPositions.roomSlug, [localZoneSlug, TOWN_SQUARE_SLUG]),
    ));
  const readMap = new Map(readPositions.map((r) => [r.roomSlug, r.lastReadAt]));
  const localLastRead = readMap.get(localZoneSlug) ?? null;
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
    timezoneZone: localZoneSlug,
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

  // ── 4b. Globe rooms the user is a member of (excluding Town Square) ─────
  // Phase 11 D-04: one row per non-Town-Square membership. These rows
  // participate in the same DM/Group sort bucket — unreadCount DESC,
  // lastMessageAt DESC — and are merged in step 5g. Town Square is
  // excluded (it has its own type: 'town_square' row at index 1).
  const globeRoomMembershipRows = await db
    .select({ roomSlug: globeRoomMemberships.roomSlug })
    .from(globeRoomMemberships)
    .where(
      and(
        eq(globeRoomMemberships.userId, userId),
        ne(globeRoomMemberships.roomSlug, TOWN_SQUARE_SLUG),
      ),
    );

  const globeRoomRows: Array<ChatsRow & { lastMessageAt: Date | null }> = [];
  if (globeRoomMembershipRows.length > 0) {
    const joinedSlugs = globeRoomMembershipRows.map((r) => r.roomSlug);

    // One read-position query for all joined regional slugs at once
    // (mirrors the step-2 pattern at routes/chats.ts:46-52).
    const joinedReadPositions = await db
      .select({
        roomSlug: globeReadPositions.roomSlug,
        lastReadAt: globeReadPositions.lastReadAt,
      })
      .from(globeReadPositions)
      .where(
        and(
          eq(globeReadPositions.userId, userId),
          inArray(globeReadPositions.roomSlug, joinedSlugs),
        ),
      );
    const joinedReadMap = new Map(joinedReadPositions.map((r) => [r.roomSlug, r.lastReadAt]));

    // Per-slug: unread count + last message (N+1, acceptable at <=30 rooms).
    // Phase 15 D-04 + D-05 + D-08: slug may be a globe-room (existing
    // behavior preserved) or a timezone-room (new, gated by caps + dedup).
    await Promise.all(
      joinedSlugs.map(async (slug) => {
        const isGlobe = isValidGlobeRoom(slug);
        const isTimezone = isValidTimezoneRoom(slug);

        // Globe branch — preserved verbatim from Phase 11.
        if (isGlobe) {
          const room = GLOBE_ROOMS.find((r) => r.slug === slug);
          if (!room) return; // defensive — orphaned slug
          const roomId = 'globe:' + slug;
          const lastRead = joinedReadMap.get(slug) ?? null;

          const unreadWhere = lastRead
            ? and(
                eq(messages.roomId, roomId),
                gt(messages.createdAt, lastRead),
                ne(messages.senderId, userId),
                isNull(messages.deletedAt),
              )
            : and(
                eq(messages.roomId, roomId),
                ne(messages.senderId, userId),
                isNull(messages.deletedAt),
              );

          const [unreadRow] = await db
            .select({ c: count() })
            .from(messages)
            .where(unreadWhere)
            .limit(1);

          const [lastMsg] = await db
            .select({ content: messages.content, createdAt: messages.createdAt })
            .from(messages)
            .where(and(eq(messages.roomId, roomId), isNull(messages.deletedAt)))
            .orderBy(desc(messages.createdAt))
            .limit(1);

          globeRoomRows.push({
            type: 'globe_room' as const,
            roomSlug: slug,
            displayName: room.displayName,
            unreadCount: Math.min(unreadRow?.c ?? 0, 99),
            lastMessage: lastMsg
              ? { preview: lastMsg.content ?? '', at: (lastMsg.createdAt as Date).toISOString() }
              : null,
            lastMessageAt: (lastMsg?.createdAt as Date | undefined) ?? null,
          });
          return;
        }

        // Timezone branch — NEW (Phase 15 TZRM-01).
        if (isTimezone) {
          // D-05 dedup: caller already sees their native zone as Local Chat
          // row[0]; do NOT emit a duplicate row here.
          if (slug === callerNativeSlug) return;
          // D-08 caps filter: free users do NOT see non-native timezone
          // rooms in the Chats list even if a membership row exists.
          if (!callerCanAccessNonNativeTimezone(caps)) return;

          const roomId = timezoneRoomId(slug);
          const lastRead = joinedReadMap.get(slug) ?? null;

          const unreadWhere = lastRead
            ? and(
                eq(messages.roomId, roomId),
                gt(messages.createdAt, lastRead),
                ne(messages.senderId, userId),
                isNull(messages.deletedAt),
              )
            : and(
                eq(messages.roomId, roomId),
                ne(messages.senderId, userId),
                isNull(messages.deletedAt),
              );

          const [unreadRow] = await db
            .select({ c: count() })
            .from(messages)
            .where(unreadWhere)
            .limit(1);

          const [lastMsg] = await db
            .select({ content: messages.content, createdAt: messages.createdAt })
            .from(messages)
            .where(and(eq(messages.roomId, roomId), isNull(messages.deletedAt)))
            .orderBy(desc(messages.createdAt))
            .limit(1);

          globeRoomRows.push({
            type: 'timezone_room' as const,
            zoneSlug: slug,
            displayName: getTimezoneZone(slug)?.displayName ?? slug,
            unreadCount: Math.min(unreadRow?.c ?? 0, 99),
            lastMessage: lastMsg
              ? { preview: lastMsg.content ?? '', at: (lastMsg.createdAt as Date).toISOString() }
              : null,
            lastMessageAt: (lastMsg?.createdAt as Date | undefined) ?? null,
          });
          return;
        }

        // Orphaned slug — defensive; should not occur post-migration 0019.
        console.warn('[chats] orphaned membership slug=' + slug);
      }),
    );
  }

  // ── 5. DMs + Groups: list of participations + blocked filter ────────────
  const participations = await db
    .select({ conversationId: conversationParticipants.conversationId, mutedAt: conversationParticipants.mutedAt })
    .from(conversationParticipants)
    .where(and(
      eq(conversationParticipants.userId, userId),
      isNull(conversationParticipants.hiddenAt),
      isNull(conversationParticipants.leftAt),
      isNull(conversationParticipants.archivedAt),
    ));

  const dmsAndGroups: ChatsRow[] = [];
  let dmRows: Array<ChatsRow & { lastMessageAt: Date | null }> = [];
  let groupRows: Array<ChatsRow & { lastMessageAt: Date | null }> = [];

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
    // MUTE-05 / MUTE-07: computed from participant rows already fetched above.
    const mutedMap = new Map<number, boolean>(
      participations.map((p) => [p.conversationId, p.mutedAt !== null]),
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
        // Drizzle interpolates `${conversations.id}` as bare `"id"` which PG
        // resolves against the inner scope (cp.id), silently miscounting.
        // Use explicit `conversations.id` reference inline.
        memberCount: sql<number>`(SELECT count(*)::int FROM conversation_participants cp WHERE cp.conversation_id = conversations.id AND cp.left_at IS NULL)`,
        // Phase 12 D-11: public/archive fields for mobile ChatsRow group variant
        isPublic: conversations.isPublic,
        isArchived: sql<boolean>`${conversations.archivedAt} IS NOT NULL`,
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
    dmRows = await Promise.all(
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
          isUserArchived: false,
          isMuted: mutedMap.get(row.conversationId) ?? false,
          lastMessageAt: row.lastMessageAt ?? null,
        };
      }),
    );

    // ── 5f. Last-message preview for Groups ───────────────────────────────
    groupRows = await Promise.all(
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
          isUserArchived: false,
          isMuted: mutedMap.get(row.conversationId) ?? false,
          lastMessageAt: row.lastMessageAt ?? null,
          // Phase 12 D-11: public/archive fields
          isPublic: row.isPublic ?? false,
          isArchived: Boolean(row.isArchived),
        };
      }),
    );
  }

  // ── 5g. Merge + sort (unreadCount DESC, lastMessageAt DESC) ───────────────
  // Phase 11 D-04: globe_room rows participate in the same bucket as DMs
  // and Groups (NOT pinned). Same sort comparator handles all three.
  // Step runs unconditionally so a user with zero DMs/Groups but one or
  // more joined regional Globe rooms still sees those rows in the list.
  const merged: Array<ChatsRow & { lastMessageAt: Date | null }> = [
    ...dmRows,
    ...groupRows,
    ...globeRoomRows,
  ];
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

  // ── 6. Final assembly — server owns the array order ─────────────────────
  const rows: ChatsRow[] = [localChatRow, townSquareRow, ...dmsAndGroups];
  const body: ChatsListResponse = { rows };
  res.json(body);
});

// ── GET /api/chats/archived — caller's archived dm + group rows ───────────
// Returns only dm + group conversations where the caller's participant row has
// archived_at IS NOT NULL. Room types (local_chat, town_square, globe_room,
// timezone_room) are never archivable and are never returned here.
// Response shape is identical to GET /api/chats (ChatsListResponse { rows }).
router.get('/archived', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;

  // ── 1. Participations where archived_at IS NOT NULL ─────────────────────
  const participations = await db
    .select({ conversationId: conversationParticipants.conversationId, mutedAt: conversationParticipants.mutedAt })
    .from(conversationParticipants)
    .where(and(
      eq(conversationParticipants.userId, userId),
      isNull(conversationParticipants.leftAt),
      sql`${conversationParticipants.archivedAt} IS NOT NULL`,
    ));

  const rows: ChatsRow[] = [];

  if (participations.length === 0) {
    res.json({ rows } as ChatsListResponse);
    return;
  }

  const convIds = participations.map((p) => p.conversationId);

  // ── 2. Unread aggregate ──────────────────────────────────────────────────
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
  // MUTE-05 / MUTE-07: muted+archived is a valid combo (RESEARCH Pitfall 6).
  const mutedMap = new Map<number, boolean>(
    participations.map((p) => [p.conversationId, p.mutedAt !== null]),
  );

  // ── 3. Blocked-user IDs (excluded from DM rows) ─────────────────────────
  const blockedRows = await db
    .select({ blockedUserId: blockedUsers.blockedUserId })
    .from(blockedUsers)
    .where(eq(blockedUsers.userId, userId));
  const blockedIds = blockedRows.map((r) => r.blockedUserId);

  // ── 4. 1-on-1 DMs ────────────────────────────────────────────────────────
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

  // ── 5. Groups ─────────────────────────────────────────────────────────────
  const groupResult = await db
    .select({
      conversationId: conversations.id,
      groupName: conversations.groupName,
      groupIconUrl: conversations.groupIconUrl,
      lastMessageAt: conversations.lastMessageAt,
      memberCount: sql<number>`(SELECT count(*)::int FROM conversation_participants cp WHERE cp.conversation_id = conversations.id AND cp.left_at IS NULL)`,
      isPublic: conversations.isPublic,
      isArchived: sql<boolean>`${conversations.archivedAt} IS NOT NULL`,
    })
    .from(conversations)
    .where(
      and(
        inArray(conversations.id, convIds),
        eq(conversations.isGroup, true),
      ),
    )
    .orderBy(desc(conversations.lastMessageAt));

  // ── 6. Last-message previews for DMs ─────────────────────────────────────
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
        isUserArchived: true,
        isMuted: mutedMap.get(row.conversationId) ?? false,
        lastMessageAt: row.lastMessageAt ?? null,
      };
    }),
  );

  // ── 7. Last-message previews for Groups ───────────────────────────────────
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
        isUserArchived: true,
        isMuted: mutedMap.get(row.conversationId) ?? false,
        lastMessageAt: row.lastMessageAt ?? null,
        isPublic: row.isPublic ?? false,
        isArchived: Boolean(row.isArchived),
      };
    }),
  );

  // ── 8. Merge + sort (unreadCount DESC, lastMessageAt DESC) ────────────────
  const merged: Array<ChatsRow & { lastMessageAt: Date | null }> = [
    ...dmRows,
    ...groupRows,
  ];
  merged.sort((a, b) => {
    if (b.unreadCount !== a.unreadCount) return b.unreadCount - a.unreadCount;
    const aTime = a.lastMessageAt?.getTime() ?? 0;
    const bTime = b.lastMessageAt?.getTime() ?? 0;
    return bTime - aTime;
  });

  for (const row of merged) {
    const { lastMessageAt: _sortKey, ...rowOnly } = row;
    void _sortKey;
    rows.push(rowOnly);
  }

  res.json({ rows } as ChatsListResponse);
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
