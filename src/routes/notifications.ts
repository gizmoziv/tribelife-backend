import { Router, Response } from 'express';
import { eq, and, desc, sql, inArray, or, isNull, gt, ne, exists } from 'drizzle-orm';
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
import { getIO } from '../lib/socketRegistry';
import { emitReadForConversations } from '../socket/receipts';
import { getBellSummary } from '../services/notificationSummary';
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
//   groups  — STORED: count of DISTINCT entityIds (chats) that have ≥1 unread
//             stored type:'group' row for the user (DM-parity with dms). One
//             dot-per-chat, matching the collapsed bell. Definition (C4): a
//             chat counts as unread in the groups bell iff there is at least one
//             unread type:'group' notification row for it keyed by entityId.
//             COEXISTENCE GAP (C4): chats that had unread messages before this
//             plan shipped have no stored group rows until their next message.
//             The in-chat bubble still reflects pre-existing unread (read-position-
//             derived); the bell self-heals on the next message per chat.
//             Acceptable — no backfill migration required.
//   dms     — unread type:'mention' rows + derived count of 1:1 DM conversations
//             with unread messages (same exists() pattern as before).
//   matches — unread type:'beacon_match' rows.
//   system  — unread type:'system' rows (includes moderation notices from imageModeration.ts).
router.get('/summary', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  // Bell buckets computed by the shared getBellSummary (services/notificationSummary.ts)
  // — SAME source of truth the push app-icon badge uses, so the two can't diverge.
  res.json(await getBellSummary(userId));
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
// 'groups' clears stored type:'group' rows AND advances read positions (C4 coupling).
const TAB_TYPES: Record<string, string[]> = {
  dms: ['mention', 'new_dm'],
  matches: ['beacon_match'],
  system: ['system'],
  groups: ['group'],
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
  } else if (typeParam) {
    // Legacy ?type= — treat as a single-type clear for backward tolerance.
    const allowedLegacy = ['mention', 'new_dm', 'beacon_match', 'system'];
    if (allowedLegacy.includes(typeParam)) typesToClear = [typeParam];
  }
  const isGroupsTab = tabParam === 'groups';
  const typeFilter = typesToClear.length > 0
    ? inArray(notifications.type, typesToClear)
    : undefined;

  // ── Groups tab: BOTH mark stored type:'group' rows read AND advance read positions (C4) ─
  // C4 single unread truth: the bell dot (stored group rows) and the in-chat
  // bubble (read-position-derived) MUST clear together so they cannot drift.
  // /read-all?tab=groups therefore:
  //   1. Marks all unread type:'group' rows read for this user.
  //   2. Advances globeReadPositions (local zone, town-square, joined globe rooms).
  //   3. Advances conversationParticipants.lastReadAt for GROUP conversations.
  // Returns cleared slugs + conversationIds in the standard response shape.
  if (isGroupsTab) {
    const now = new Date();

    // Step 1 (C4): Mark all unread type:'group' rows read.
    await db
      .update(notifications)
      .set({ isRead: true })
      .where(and(
        eq(notifications.userId, userId),
        eq(notifications.type, 'group'),
        eq(notifications.isRead, false),
      ));

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

    // Step 2: Advance globeReadPositions for all multi-person room slugs.
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

    // Step 3: Advance lastReadAt for GROUP (isGroup = true) conversations.
    // Does NOT touch 1:1 DMs (those stay in the dms tab).
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

    // Read state advanced for these GROUP conversations → emit message:read
    // (RCPT-06/07). All groups → the helper always emits (PRIV-04).
    const io = getIO();
    if (io && groupConvIds.length > 0) {
      await emitReadForConversations(io, groupConvIds, userId)
        .catch((err) => console.error('[receipts/read]', err));
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

    // Read state advanced → emit message:read (RCPT-06/07). conversationIdList
    // may mix DMs and groups; the helper's per-conversation gate handles each
    // (DM reciprocal, group always). globe/room read path below emits nothing
    // (RCPT-09 — rooms have no receipts).
    const io = getIO();
    if (io) {
      await emitReadForConversations(io, conversationIdList, userId)
        .catch((err) => console.error('[receipts/read]', err));
    }
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

  // C4 single unread truth: also mark stored type:'group' rows read for this
  // chat so the Groups bell dot clears at the same time as the in-chat bubble.
  // entityId is the canonical chat key written by the fan-out:
  //   group convo  → entityId = String(conversationId)
  //   globe_room   → entityId = slug after 'globe:' (e.g. 'town-square')
  //   local_chat   → entityId = raw IANA timezone (e.g. 'America/New_York')
  //                  NOTE: roomId from client is 'timezone:<slug>' but the fan-out
  //                  stores the raw IANA as entityId. We look it up from the user's
  //                  profile so we clear the correct group rows.
  let groupEntityId: string | undefined;
  if (conversationId !== undefined) {
    groupEntityId = String(conversationId);
  } else if (roomId.roomId) {
    const r = roomId.roomId;
    if (r.startsWith('globe:')) {
      // globe_room: entityId = slug (e.g. 'town-square', 'north-america')
      groupEntityId = r.slice('globe:'.length);
    } else if (r.startsWith('timezone:')) {
      // local_chat: entityId = raw IANA. Look up from user's profile.
      const [pRow] = await db
        .select({ timezone: userProfiles.timezone })
        .from(userProfiles)
        .where(eq(userProfiles.userId, userId))
        .limit(1);
      if (pRow?.timezone) groupEntityId = pRow.timezone;
    }
  }

  const clearedGroup = groupEntityId !== undefined
    ? await db
        .update(notifications)
        .set({ isRead: true })
        .where(and(
          eq(notifications.userId, userId),
          eq(notifications.type, 'group'),
          eq(notifications.isRead, false),
          sql`${notifications.data}->>'entityId' = ${groupEntityId}`,
        ))
        .returning({ id: notifications.id })
    : [];

  res.json({ markedRead: [...updated.map((r) => r.id), ...clearedGroup.map((r) => r.id)] });
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
  // M3: raw body cast (no zod), matches existing dmsPush/beaconMatchesPush style.
  // groupsPush added per D-15 — gates plain-message group push (16-06 column).
  // readReceipts added per PRIV-01 — server-side toggle gating DM message:read
  // (column default stays true; absence here leaves the existing value untouched).
  const { beaconMatchesPush, dmsPush, groupsPush, readReceipts } = req.body as {
    beaconMatchesPush?: boolean;
    dmsPush?: boolean;
    groupsPush?: boolean;
    readReceipts?: boolean;
  };

  const updates: Partial<typeof notificationPreferences.$inferInsert> = {};
  if (beaconMatchesPush !== undefined) updates.beaconMatchesPush = beaconMatchesPush;
  if (dmsPush !== undefined) updates.dmsPush = dmsPush;
  if (groupsPush !== undefined) updates.groupsPush = groupsPush;
  if (readReceipts !== undefined) updates.readReceipts = readReceipts;

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
