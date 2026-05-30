import { Router, Response } from 'express';
import { eq, and, desc, sql, inArray, or, isNull, gt, ne, exists, count } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import {
  notifications,
  notificationPreferences,
  conversationParticipants,
  conversations,
  messages,
  globeReadPositions,
  globeRoomMemberships,
  userProfiles,
} from '../db/schema';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { translateLegacyTimezoneRoomId, getZoneForTimezone } from '../config/timezoneZones';
import logger from '../lib/logger';

const router = Router();
router.use(requireAuth);

// ── Get notifications for current user ────────────────────────────────────
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const limit = Math.min(parseInt(req.query.limit as string ?? '30'), 50);

  const userNotifications = await db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);

  const unreadCount = userNotifications.filter((n) => !n.isRead).length;

  res.json({ notifications: userNotifications, unreadCount });
});

// ── Summary: unread *events* bucketed for the bell + per-tab dots ─────────
// Response shape: { groups, dms, matches, system }
//   groups  — DERIVED: count of multi-person chats (local_chat, town_square,
//             joined globe_room, group) with ≥1 unread plain message not
//             authored by the user. Excludes 1:1 DMs (those go to dms).
//             Mirrors the unread fragments from routes/chats.ts sections 3/4/4b/5.
//   dms     — unread type:'mention' rows + derived count of 1:1 DM conversations
//             with unread messages (same exists() pattern as previous dmConversations).
//   matches — unread type:'beacon_match' rows.
//   system  — unread type:'system' rows (includes moderation notices from imageModeration.ts).
router.get('/summary', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;

  // ── Stored notification counts (mentions, matches, system) ───────────────
  const [notifRows] = await db
    .select({
      mentions: sql<number>`count(*) filter (where ${notifications.type} = 'mention' and ${notifications.isRead} = false)`.mapWith(Number),
      beaconMatches: sql<number>`count(*) filter (where ${notifications.type} = 'beacon_match' and ${notifications.isRead} = false)`.mapWith(Number),
      system: sql<number>`count(*) filter (where ${notifications.type} = 'system' and ${notifications.isRead} = false)`.mapWith(Number),
    })
    .from(notifications)
    .where(eq(notifications.userId, userId));

  // ── DMs: unread mention rows + 1:1 DM conversations with unread ───────────
  // Count distinct 1:1 conversations with at least one message newer than
  // the user's lastReadAt on that conversation (and not authored by them).
  // Mirrors the previous dmConversations fragment (chats.ts:310-321 pattern).
  const [dmConvRow] = await db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(conversationParticipants)
    .where(and(
      eq(conversationParticipants.userId, userId),
      // 1:1 DM only (isGroup IS NOT TRUE — mirrors chats.ts:5c)
      exists(
        db
          .select({ id: conversations.id })
          .from(conversations)
          .where(and(
            eq(conversations.id, conversationParticipants.conversationId),
            sql`${conversations.isGroup} IS NOT TRUE`,
          )),
      ),
      exists(
        db
          .select({ id: messages.id })
          .from(messages)
          .where(and(
            eq(messages.conversationId, conversationParticipants.conversationId),
            ne(messages.senderId, userId),
            or(
              isNull(conversationParticipants.lastReadAt),
              gt(messages.createdAt, conversationParticipants.lastReadAt),
            ),
          )),
      ),
    ));

  const dms = (notifRows?.mentions ?? 0) + (dmConvRow?.count ?? 0);

  // ── Groups: DERIVED count of multi-person chats with unread plain messages ─
  // Counts each SOURCE (not each message) with ≥1 unread message not by user.
  // Sources: local_chat zone, town_square, joined non-town-square globe rooms,
  // group conversations. 1:1 DMs are EXCLUDED.
  // Cross-reference: chats.ts sections 3 (local), 4 (town_square), 4b (globe_room), 5d (group).

  // Look up user's timezone for local chat room slug.
  const [profileRow] = await db
    .select({ timezone: userProfiles.timezone })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  const userTimezone = profileRow?.timezone ?? 'UTC';
  const localZoneSlug = getZoneForTimezone(userTimezone);
  const localRoomId = 'timezone:' + localZoneSlug;

  // Fetch read positions for local zone + town square in one query.
  const readPositions = await db
    .select({ roomSlug: globeReadPositions.roomSlug, lastReadAt: globeReadPositions.lastReadAt })
    .from(globeReadPositions)
    .where(and(
      eq(globeReadPositions.userId, userId),
      inArray(globeReadPositions.roomSlug, [localZoneSlug, 'town-square']),
    ));
  const readMap = new Map(readPositions.map((r) => [r.roomSlug, r.lastReadAt]));
  const localLastRead = readMap.get(localZoneSlug) ?? null;
  const townLastRead = readMap.get('town-square') ?? null;

  // Local Chat: ≥1 unread message not by user in timezone:<localZoneSlug>?
  const localWhere = localLastRead
    ? and(eq(messages.roomId, localRoomId), gt(messages.createdAt, localLastRead), ne(messages.senderId, userId), isNull(messages.deletedAt))
    : and(eq(messages.roomId, localRoomId), ne(messages.senderId, userId), isNull(messages.deletedAt));
  const [localUnread] = await db
    .select({ c: count() })
    .from(messages)
    .where(localWhere)
    .limit(1);
  const localHasUnread = (localUnread?.c ?? 0) > 0;

  // Town Square: ≥1 unread message not by user in globe:town-square?
  const townWhere = townLastRead
    ? and(eq(messages.roomId, 'globe:town-square'), gt(messages.createdAt, townLastRead), ne(messages.senderId, userId), isNull(messages.deletedAt))
    : and(eq(messages.roomId, 'globe:town-square'), ne(messages.senderId, userId), isNull(messages.deletedAt));
  const [townUnread] = await db
    .select({ c: count() })
    .from(messages)
    .where(townWhere)
    .limit(1);
  const townHasUnread = (townUnread?.c ?? 0) > 0;

  // Joined globe rooms (excluding town-square): count rooms with ≥1 unread.
  // Mirrors chats.ts section 4b globe branch.
  const joinedGlobeRows = await db
    .select({ roomSlug: globeRoomMemberships.roomSlug })
    .from(globeRoomMemberships)
    .where(and(
      eq(globeRoomMemberships.userId, userId),
      ne(globeRoomMemberships.roomSlug, 'town-square'),
    ));
  let globeRoomsWithUnread = 0;
  if (joinedGlobeRows.length > 0) {
    const joinedSlugs = joinedGlobeRows.map((r) => r.roomSlug);
    const joinedReadPos = await db
      .select({ roomSlug: globeReadPositions.roomSlug, lastReadAt: globeReadPositions.lastReadAt })
      .from(globeReadPositions)
      .where(and(
        eq(globeReadPositions.userId, userId),
        inArray(globeReadPositions.roomSlug, joinedSlugs),
      ));
    const joinedReadMap = new Map(joinedReadPos.map((r) => [r.roomSlug, r.lastReadAt]));
    await Promise.all(
      joinedSlugs.map(async (slug) => {
        const roomId = 'globe:' + slug;
        const lastRead = joinedReadMap.get(slug) ?? null;
        const unreadWhere = lastRead
          ? and(eq(messages.roomId, roomId), gt(messages.createdAt, lastRead), ne(messages.senderId, userId), isNull(messages.deletedAt))
          : and(eq(messages.roomId, roomId), ne(messages.senderId, userId), isNull(messages.deletedAt));
        const [unreadRow] = await db.select({ c: count() }).from(messages).where(unreadWhere).limit(1);
        if ((unreadRow?.c ?? 0) > 0) globeRoomsWithUnread++;
      }),
    );
  }

  // Group conversations (isGroup = true) with ≥1 unread message not by user.
  // Mirrors chats.ts section 5d. 1:1 DMs (isGroup IS NOT TRUE) are excluded.
  const [groupUnreadRow] = await db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(conversationParticipants)
    .where(and(
      eq(conversationParticipants.userId, userId),
      exists(
        db
          .select({ id: conversations.id })
          .from(conversations)
          .where(and(
            eq(conversations.id, conversationParticipants.conversationId),
            eq(conversations.isGroup, true),
          )),
      ),
      exists(
        db
          .select({ id: messages.id })
          .from(messages)
          .where(and(
            eq(messages.conversationId, conversationParticipants.conversationId),
            ne(messages.senderId, userId),
            or(
              isNull(conversationParticipants.lastReadAt),
              gt(messages.createdAt, conversationParticipants.lastReadAt),
            ),
          )),
      ),
    ));

  const groups =
    (localHasUnread ? 1 : 0) +
    (townHasUnread ? 1 : 0) +
    globeRoomsWithUnread +
    (groupUnreadRow?.count ?? 0);

  res.json({
    groups,
    dms,
    matches: notifRows?.beaconMatches ?? 0,
    system: notifRows?.system ?? 0,
  });
});

// ── Mark notifications as read ─────────────────────────────────────────────
// Accepts ?tab= (canonical TAB semantics, W1 LOCKED) OR legacy ?type= for
// backward tolerance. Tab→type[] expansion:
//   tab=dms      → clears 'mention' + 'new_dm' rows
//   tab=matches  → clears 'beacon_match' rows
//   tab=system   → clears 'system' rows
//   tab=groups   → NO stored-row clear; advances read positions across ALL
//                  unread multi-person chats (Groups is derived — no rows).
// Legacy ?type= still accepted: maps to the single type it names.
// Clearing a stored bucket also cascades to the *sources* those events came
// from (conversations lastReadAt, globeReadPositions) so chat unread badges
// clear together with the bell tab.
// Returns source IDs touched so the client can refresh derived state.

// Inverse of typeToTab: maps a tab name to the notification types it clears.
// 'groups' has no stored types — handled separately by the read-position cascade.
const TAB_TYPES: Record<string, string[]> = {
  dms: ['mention', 'new_dm'],
  matches: ['beacon_match'],
  system: ['system'],
};

router.put('/read-all', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;

  // Resolve tab param (new canonical) or fall back to legacy type param.
  const tabParam = typeof req.query.tab === 'string' ? req.query.tab : undefined;
  const typeParam = typeof req.query.type === 'string' ? req.query.type : undefined;

  // Determine which notification types to clear (empty = clear all).
  let typesToClear: string[] = [];
  if (tabParam && TAB_TYPES[tabParam]) {
    typesToClear = TAB_TYPES[tabParam];
  } else if (tabParam === 'groups') {
    // Groups tab — no stored rows; handled below by read-position cascade.
    typesToClear = [];
  } else if (typeParam) {
    // Legacy ?type= — treat as a single-type clear for backward tolerance.
    const allowedLegacy = ['mention', 'new_dm', 'beacon_match', 'system'];
    if (allowedLegacy.includes(typeParam)) typesToClear = [typeParam];
  }
  // tabParam is 'groups' OR (no tab and no recognized type) → clear all
  const isGroupsTab = tabParam === 'groups';
  const typeFilter = typesToClear.length > 0
    ? inArray(notifications.type, typesToClear)
    : undefined;

  // ── Groups tab: advance read positions across all unread multi-person chats ─
  // Groups is a derived tab (no stored rows). Clearing it advances:
  //   • globeReadPositions for local zone, town-square, joined globe rooms with unread
  //   • conversationParticipants.lastReadAt for GROUP (not 1:1) conversations with unread
  // Returns cleared slugs + conversationIds in the standard response shape.
  if (isGroupsTab) {
    const now = new Date();

    // Look up user's local zone for local_chat read position.
    const [profileRow] = await db
      .select({ timezone: userProfiles.timezone })
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .limit(1);
    const userTimezone = profileRow?.timezone ?? 'UTC';
    const localZoneSlug = getZoneForTimezone(userTimezone);
    const localRoomId = 'timezone:' + localZoneSlug;

    // Gather all globe slugs to advance: local zone + town-square + joined non-town-square.
    const slugsToAdvance: string[] = [localZoneSlug, 'town-square'];
    const joinedGlobe = await db
      .select({ roomSlug: globeRoomMemberships.roomSlug })
      .from(globeRoomMemberships)
      .where(and(
        eq(globeRoomMemberships.userId, userId),
        ne(globeRoomMemberships.roomSlug, 'town-square'),
      ));
    for (const r of joinedGlobe) slugsToAdvance.push(r.roomSlug);

    // Advance globeReadPositions for all multi-person room slugs.
    // Only advance slugs that actually have unread to minimise writes — but
    // for simplicity (mirrors the existing cascade pattern :169-179) we upsert
    // all collected slugs unconditionally.
    const clearedGlobeSlugs: string[] = [];
    await Promise.all(
      slugsToAdvance.map(async (slug) => {
        await db
          .insert(globeReadPositions)
          .values({ userId, roomSlug: slug, lastReadAt: now })
          .onConflictDoUpdate({
            target: [globeReadPositions.userId, globeReadPositions.roomSlug],
            set: { lastReadAt: now },
          });
        clearedGlobeSlugs.push(slug);
      }),
    );

    // Advance lastReadAt for GROUP (isGroup = true) conversations the user is in.
    // Does NOT touch 1:1 DMs (those stay in the dms tab). Mirrors chats.ts 5d.
    const groupParticipations = await db
      .select({ conversationId: conversationParticipants.conversationId })
      .from(conversationParticipants)
      .where(and(
        eq(conversationParticipants.userId, userId),
        isNull(conversationParticipants.leftAt),
        exists(
          db
            .select({ id: conversations.id })
            .from(conversations)
            .where(and(
              eq(conversations.id, conversationParticipants.conversationId),
              eq(conversations.isGroup, true),
            )),
        ),
      ));
    const groupConvIds = groupParticipations.map((p) => p.conversationId);
    if (groupConvIds.length > 0) {
      await db
        .update(conversationParticipants)
        .set({ lastReadAt: now })
        .where(and(
          eq(conversationParticipants.userId, userId),
          inArray(conversationParticipants.conversationId, groupConvIds),
        ));
    }

    res.json({
      clearedConversationIds: groupConvIds,
      clearedGlobeSlugs,
      clearedTimezoneRooms: [localRoomId],
    });
    return;
  }

  // ── Stored-row clear (dms / matches / system / all) ───────────────────────
  // Step 1: find the unread rows we're about to clear so we can inspect their
  // source payloads. Doing this before the UPDATE keeps the cascade precise.
  const affected = await db
    .select({ id: notifications.id, data: notifications.data })
    .from(notifications)
    .where(and(
      eq(notifications.userId, userId),
      eq(notifications.isRead, false),
      ...(typeFilter ? [typeFilter] : []),
    ));

  const conversationIds = new Set<number>();
  const globeSlugs = new Set<string>();
  const timezoneRooms: string[] = [];
  for (const row of affected) {
    const d = (row.data ?? {}) as Record<string, unknown>;
    const convId = typeof d.conversationId === 'number'
      ? d.conversationId
      : typeof d.conversationId === 'string'
        ? parseInt(d.conversationId, 10)
        : NaN;
    if (!Number.isNaN(convId) && convId > 0) conversationIds.add(convId);
    const roomId = typeof d.roomId === 'string' ? d.roomId : undefined;
    const globeSlug = typeof d.globeSlug === 'string' ? d.globeSlug : undefined;
    if (globeSlug) globeSlugs.add(globeSlug);
    else if (roomId?.startsWith('globe:')) globeSlugs.add(roomId.slice('globe:'.length));
    else if (roomId?.startsWith('timezone:')) timezoneRooms.push(roomId);
  }

  // Step 2: mark the bucket's own notifications read.
  await db
    .update(notifications)
    .set({ isRead: true })
    .where(and(
      eq(notifications.userId, userId),
      eq(notifications.isRead, false),
      ...(typeFilter ? [typeFilter] : []),
    ));

  // Step 3: cross-type cleanup — any other unread notifications tied to the
  // same conversations get cleared too. A group chat that had both a new_dm
  // and a mention ends up fully clean from either direction.
  const conversationIdList = Array.from(conversationIds);
  if (conversationIdList.length > 0) {
    await db
      .update(notifications)
      .set({ isRead: true })
      .where(and(
        eq(notifications.userId, userId),
        eq(notifications.isRead, false),
        sql`(${notifications.data}->>'conversationId')::int IN (${sql.join(conversationIdList.map((id) => sql`${id}`), sql`, `)})`,
      ));
  }

  // Step 4: cascade to source read state.
  if (conversationIdList.length > 0) {
    await db
      .update(conversationParticipants)
      .set({ lastReadAt: new Date() })
      .where(and(
        eq(conversationParticipants.userId, userId),
        inArray(conversationParticipants.conversationId, conversationIdList),
      ));
  }

  const globeSlugList = Array.from(globeSlugs);
  if (globeSlugList.length > 0) {
    const now = new Date();
    await Promise.all(
      globeSlugList.map((slug) =>
        db
          .insert(globeReadPositions)
          .values({ userId, roomSlug: slug, lastReadAt: now })
          .onConflictDoUpdate({
            target: [globeReadPositions.userId, globeReadPositions.roomSlug],
            set: { lastReadAt: now },
          }),
      ),
    );
  }

  res.json({
    clearedConversationIds: conversationIdList,
    clearedGlobeSlugs: globeSlugList,
    clearedTimezoneRooms: Array.from(new Set(timezoneRooms)),
  });
});

router.put('/:id/read', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const notifId = parseInt(req.params.id as string, 10);
  if (isNaN(notifId)) { res.status(400).json({ error: 'Invalid ID' }); return; }

  await db
    .update(notifications)
    .set({ isRead: true })
    .where(and(eq(notifications.id, notifId), eq(notifications.userId, userId)));

  res.json({ ok: true });
});

// ── Mark notifications for a chat context as read ─────────────────────────
// Called when the user opens a chat/room directly (not via a notification
// tap) so notifications tied to that context clear from the bell badge.
//   body: { conversationId?: number }  → marks new_dm + DM-context mentions
//   body: { roomId?: string }          → marks mentions in a timezone/globe room
// Exactly one of the fields must be present.
const readContextSchema = z.object({
  conversationId: z.number().int().positive().optional(),
  roomId: z.string().min(1).max(200).optional(),
}).refine(
  (v) => (v.conversationId === undefined) !== (v.roomId === undefined),
  { message: 'Provide exactly one of conversationId or roomId' },
);

router.put('/read-context', async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = readContextSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  const userId = req.user!.id;
  const { conversationId, roomId: rawRoomId } = parse.data;

  // Backward-compat shim for clients on ≤v1.4.5 that still send roomIds in the
  // legacy `timezone:<IANA>` form. Phase 15 migration 0019 also rewrote every
  // `notifications.data.roomId` to the canonical `timezone:<slug>` form, so
  // an unshimmed mark-read against the IANA value would match zero rows and
  // the bell badge would never clear. See translateLegacyTimezoneRoomId for
  // the removal plan.
  const roomId = rawRoomId !== undefined
    ? translateLegacyTimezoneRoomId(rawRoomId)
    : { roomId: undefined as string | undefined, wasLegacy: false };
  if (roomId.wasLegacy) {
    logger.info(
      { userId, route: 'PUT /notifications/read-context', original: rawRoomId, translated: roomId.roomId },
      '[shim:legacy-room-id] translated IANA → canonical slug for ≤1.4.5 client',
    );
  }

  // Notification types scoped by context:
  //   conversationId → new_dm + mention rows whose data.conversationId matches
  //   roomId         → mention rows whose data.roomId matches
  const contextFilter = conversationId !== undefined
    ? and(
        inArray(notifications.type, ['new_dm', 'mention']),
        sql`${notifications.data}->>'conversationId' = ${String(conversationId)}`,
      )
    : and(
        eq(notifications.type, 'mention'),
        sql`${notifications.data}->>'roomId' = ${roomId.roomId!}`,
      );

  const updated = await db
    .update(notifications)
    .set({ isRead: true })
    .where(and(
      eq(notifications.userId, userId),
      eq(notifications.isRead, false),
      contextFilter,
    ))
    .returning({ id: notifications.id });

  res.json({ markedRead: updated.map((r) => r.id) });
});

// ── Get notification preferences ───────────────────────────────────────────
router.get('/preferences', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;

  let [prefs] = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId))
    .limit(1);

  if (!prefs) {
    [prefs] = await db
      .insert(notificationPreferences)
      .values({ userId })
      .returning();
  }

  res.json(prefs);
});

// ── Update notification preferences ────────────────────────────────────────
router.put('/preferences', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { beaconMatchesPush, dmsPush } = req.body as {
    beaconMatchesPush?: boolean;
    dmsPush?: boolean;
  };

  const updates: Partial<typeof notificationPreferences.$inferInsert> = {};
  if (beaconMatchesPush !== undefined) updates.beaconMatchesPush = beaconMatchesPush;
  if (dmsPush !== undefined) updates.dmsPush = dmsPush;

  const existing = await db
    .select({ id: notificationPreferences.id })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId))
    .limit(1);

  if (existing.length === 0) {
    const [prefs] = await db
      .insert(notificationPreferences)
      .values({ userId, ...updates })
      .returning();
    res.json(prefs);
    return;
  }

  const [prefs] = await db
    .update(notificationPreferences)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(notificationPreferences.userId, userId))
    .returning();

  res.json(prefs);
});

export default router;
