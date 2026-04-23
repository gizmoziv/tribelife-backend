import { Router, Response } from 'express';
import { eq, and, desc, sql, inArray, or, isNull, gt, ne, exists } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import {
  notifications,
  notificationPreferences,
  conversationParticipants,
  messages,
  globeReadPositions,
} from '../db/schema';
import { requireAuth, AuthRequest } from '../middleware/auth';

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
// Designed to keep the bell count low and meaningful. DMs are counted as
// unread conversations (not unread messages) so a chatty thread doesn't
// inflate the bell.
router.get('/summary', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;

  const [notifRows] = await db
    .select({
      mentions: sql<number>`count(*) filter (where ${notifications.type} = 'mention' and ${notifications.isRead} = false)`.mapWith(Number),
      beaconMatches: sql<number>`count(*) filter (where ${notifications.type} = 'beacon_match' and ${notifications.isRead} = false)`.mapWith(Number),
      system: sql<number>`count(*) filter (where ${notifications.type} = 'system' and ${notifications.isRead} = false)`.mapWith(Number),
    })
    .from(notifications)
    .where(eq(notifications.userId, userId));

  // DMs: count distinct conversations with at least one message newer than
  // the user's lastReadAt on that conversation (and not authored by them).
  const [dmRow] = await db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(conversationParticipants)
    .where(and(
      eq(conversationParticipants.userId, userId),
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

  res.json({
    mentions: notifRows?.mentions ?? 0,
    dmConversations: dmRow?.count ?? 0,
    beaconMatches: notifRows?.beaconMatches ?? 0,
    system: notifRows?.system ?? 0,
  });
});

// ── Mark notifications as read ─────────────────────────────────────────────
// Optional `type` query param scopes the clear to a single bell tab (mention,
// new_dm, beacon_match, system). Clearing a bucket cascades to the *sources*
// those events came from:
//   • conversations where events lived → `lastReadAt = NOW()` for the user
//   • globe rooms where events lived → upsert `globeReadPositions.lastReadAt`
//   • other unread notifications tied to the same conversations → marked read
//     (so clearing DMs on a group chat also clears any pending mention for that
//     group, and vice versa — as the user expects)
// Returns the source IDs touched so the client can refresh derived state
// (chat unread badges, globe unread counts, local-chat counter).
router.put('/read-all', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const typeParam = typeof req.query.type === 'string' ? req.query.type : undefined;
  const allowedTypes = ['mention', 'new_dm', 'beacon_match', 'system'] as const;
  const typeFilter = allowedTypes.includes(typeParam as typeof allowedTypes[number])
    ? eq(notifications.type, typeParam as string)
    : undefined;

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
  const { conversationId, roomId } = parse.data;

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
        sql`${notifications.data}->>'roomId' = ${roomId!}`,
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
  const { mentionsPush, timezoneChatPush, beaconMatchesPush, dmPush } = req.body as {
    mentionsPush?: boolean;
    timezoneChatPush?: boolean;
    beaconMatchesPush?: boolean;
    dmPush?: boolean;
  };

  const updates: Partial<typeof notificationPreferences.$inferInsert> = {};
  if (mentionsPush !== undefined) updates.mentionsPush = mentionsPush;
  if (timezoneChatPush !== undefined) updates.timezoneChatPush = timezoneChatPush;
  if (beaconMatchesPush !== undefined) updates.beaconMatchesPush = beaconMatchesPush;
  if (dmPush !== undefined) updates.dmPush = dmPush;

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
