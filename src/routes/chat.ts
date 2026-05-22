import { Router, Response } from 'express';
import { eq, and, inArray, desc, lt, sql, notInArray, isNull, ne, gt, or } from 'drizzle-orm';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { db } from '../db';
import {
  conversations,
  conversationParticipants,
  messages,
  messageEdits,
  users,
  userProfiles,
  blockedUsers,
} from '../db/schema';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { requireCapability } from '../middleware/capabilities';
import { attachReactions } from '../utils/attachReactions';
import { attachReplyTo } from '../utils/attachReplyTo';
import { translateMessage } from '../services/translation';
import { moderateMessage } from '../services/claude';
import type { Server } from 'socket.io';
import logger from '../lib/logger';
import type { SearchResult, SearchResponse } from '../types/searchResult';
import { GLOBE_ROOMS } from '../config/globeRooms';

const log = logger.child({ module: 'chat' });

// ── Cursor helpers (D-02: opaque base64-encoded JSON { createdAt, id }) ──────

/** Encode a pagination cursor from the last row's createdAt + id. */
function encodeCursor(createdAt: string, id: number): string {
  return Buffer.from(JSON.stringify({ createdAt, id })).toString('base64');
}

/**
 * Decode a pagination cursor. Returns null on any parse failure or shape
 * mismatch — callers must respond 400 `{ error: 'invalid cursor' }`.
 */
function decodeCursor(s: string): { createdAt: string; id: number } | null {
  try {
    const raw = JSON.parse(Buffer.from(s, 'base64').toString('utf8')) as unknown;
    if (
      typeof raw !== 'object' ||
      raw === null ||
      typeof (raw as Record<string, unknown>).createdAt !== 'string' ||
      typeof (raw as Record<string, unknown>).id !== 'number'
    ) {
      return null;
    }
    const { createdAt, id } = raw as { createdAt: string; id: number };
    return { createdAt, id };
  } catch {
    return null;
  }
}

// ── Per-route rate limiter for /search (D-08: 30 req/min per user) ────────────
// Keyed on req.user.id so shared-IP users (e.g. behind NAT) are not affected
// by each other. requireAuth is at router level (line below) so req.user is
// populated before keyGenerator runs.
const searchLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => String((req as AuthRequest).user?.id ?? req.ip),
  handler: (_req, res) => res.status(429).json({ error: 'too many search requests' }),
});

// ── Search query param schema (D-03) ─────────────────────────────────────────
const searchQuerySchema = z.object({
  q: z.string(),
  cursor: z.string().optional(),
});

// ── aroundMessageId query param schema (D-04) ─────────────────────────────────
// Shared across the 3 message-list endpoints. When `aroundMessageId` is absent
// the existing pagination path is used unchanged (regression-safe).
const aroundMessageSchema = z.object({
  aroundMessageId: z.coerce.number().int().positive().optional(),
  before: z.coerce.number().int().min(0).max(50).optional().default(25),
  after: z.coerce.number().int().min(0).max(50).optional().default(25),
});

const router = Router();
router.use(requireAuth);

// ── List DM conversations + groups for current user ─────────────────────────
router.get('/conversations', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;

  // Get all conversations the user participates in (exclude hidden)
  const participations = await db
    .select({ conversationId: conversationParticipants.conversationId })
    .from(conversationParticipants)
    .where(and(
      eq(conversationParticipants.userId, userId),
      isNull(conversationParticipants.hiddenAt),
      isNull(conversationParticipants.leftAt)
    ));

  if (participations.length === 0) {
    res.json({ conversations: [] });
    return;
  }

  const convIds = participations.map((p) => p.conversationId);

  // Compute unread counts in a single aggregate query. For each conversation
  // the user participates in, count messages sent by OTHERS after the user's
  // last_read_at (or all messages if last_read_at is null). Own sent messages
  // never count as unread.
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

  // Get blocked user IDs so we can exclude their DM conversations
  const blockedRows = await db
    .select({ blockedUserId: blockedUsers.blockedUserId })
    .from(blockedUsers)
    .where(eq(blockedUsers.userId, userId));
  const blockedIds = blockedRows.map((r) => r.blockedUserId);

  // ── Query 1: 1-on-1 DMs (isGroup IS NOT TRUE) ──────────────────────────
  const dmResult = await db
    .select({
      conversationId: conversations.id,
      lastMessageAt: conversations.lastMessageAt,
      participantId: conversationParticipants.userId,
      participantName: users.name,
      participantHandle: userProfiles.handle,
      participantAvatar: userProfiles.avatarUrl,
      lastReadAt: conversationParticipants.lastReadAt,
    })
    .from(conversations)
    .innerJoin(
      conversationParticipants,
      and(
        eq(conversationParticipants.conversationId, conversations.id),
        sql`${conversationParticipants.userId} != ${userId}`
      )
    )
    .innerJoin(users, eq(users.id, conversationParticipants.userId))
    .leftJoin(userProfiles, eq(userProfiles.userId, conversationParticipants.userId))
    .where(
      and(
        inArray(conversations.id, convIds),
        sql`${conversations.isGroup} IS NOT TRUE`,
        ...(blockedIds.length > 0 ? [notInArray(conversationParticipants.userId, blockedIds)] : [])
      )
    )
    .orderBy(desc(conversations.lastMessageAt));

  // ── Query 2: Groups ─────────────────────────────────────────────────────
  // Get user's own lastReadAt for groups
  const groupParticipations = await db
    .select({
      conversationId: conversationParticipants.conversationId,
      lastReadAt: conversationParticipants.lastReadAt,
    })
    .from(conversationParticipants)
    .where(and(
      eq(conversationParticipants.userId, userId),
      isNull(conversationParticipants.hiddenAt),
      isNull(conversationParticipants.leftAt),
      inArray(conversationParticipants.conversationId, convIds)
    ));
  const groupLastReadMap = new Map(groupParticipations.map((p) => [p.conversationId, p.lastReadAt]));

  const groupResult = await db
    .select({
      conversationId: conversations.id,
      groupName: conversations.groupName,
      groupIconUrl: conversations.groupIconUrl,
      lastMessageAt: conversations.lastMessageAt,
      inviteSlug: conversations.inviteSlug,
      memberCount: sql<number>`(SELECT count(*)::int FROM conversation_participants WHERE conversation_id = ${conversations.id} AND left_at IS NULL)`,
    })
    .from(conversations)
    .where(
      and(
        inArray(conversations.id, convIds),
        eq(conversations.isGroup, true)
      )
    )
    .orderBy(desc(conversations.lastMessageAt));

  // Attach last message preview to DMs
  const dmsWithPreview = await Promise.all(
    dmResult.map(async (row) => {
      const [lastMsg] = await db
        .select({ content: messages.content, createdAt: messages.createdAt })
        .from(messages)
        .where(eq(messages.conversationId, row.conversationId))
        .orderBy(desc(messages.createdAt))
        .limit(1);

      return {
        ...row,
        lastMessage: lastMsg ?? null,
        isGroup: false as const,
        unreadCount: unreadMap.get(row.conversationId) ?? 0,
      };
    })
  );

  // Attach last message preview to groups
  const groupsWithPreview = await Promise.all(
    groupResult.map(async (row) => {
      const [lastMsg] = await db
        .select({ content: messages.content, createdAt: messages.createdAt })
        .from(messages)
        .where(eq(messages.conversationId, row.conversationId))
        .orderBy(desc(messages.createdAt))
        .limit(1);

      return {
        conversationId: row.conversationId,
        lastMessageAt: row.lastMessageAt,
        groupName: row.groupName,
        groupIconUrl: row.groupIconUrl,
        inviteSlug: row.inviteSlug,
        memberCount: row.memberCount,
        lastReadAt: groupLastReadMap.get(row.conversationId) ?? null,
        lastMessage: lastMsg ?? null,
        isGroup: true as const,
        unreadCount: unreadMap.get(row.conversationId) ?? 0,
      };
    })
  );

  // Merge and sort by lastMessageAt DESC
  const merged = [...dmsWithPreview, ...groupsWithPreview].sort((a, b) => {
    const aTime = a.lastMessageAt?.getTime() ?? 0;
    const bTime = b.lastMessageAt?.getTime() ?? 0;
    return bTime - aTime;
  });

  res.json({ conversations: merged });
});

// ── Get or create a 1-on-1 conversation ───────────────────────────────────
router.post('/conversations', async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = z.object({ otherUserId: z.number().int().positive() }).safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'otherUserId is required' });
    return;
  }

  const userId = req.user!.id;
  const { otherUserId } = parse.data;

  if (userId === otherUserId) {
    res.status(400).json({ error: 'Cannot create conversation with yourself' });
    return;
  }

  // Check if a 1-on-1 DM conversation already exists between these two users.
  // SCHM-04: legacy 1:1 DMs have is_group = NULL; v1.7+ DMs explicitly set
  // is_group = false; groups have is_group = true. We want to match the
  // first two but NEVER a group — even a 2-member group that happens to
  // contain exactly these two users would otherwise be returned here and
  // the mobile would re-open it as a DM (Phase 12 bug).
  const existing = await db.execute(sql`
    SELECT c.id
    FROM conversations c
    WHERE c.is_group IS NOT TRUE
    AND (
      SELECT COUNT(*) FROM conversation_participants cp WHERE cp.conversation_id = c.id
    ) = 2
    AND EXISTS (SELECT 1 FROM conversation_participants WHERE conversation_id = c.id AND user_id = ${userId})
    AND EXISTS (SELECT 1 FROM conversation_participants WHERE conversation_id = c.id AND user_id = ${otherUserId})
    LIMIT 1
  `);

  if (existing.rows.length > 0) {
    res.json({ conversationId: existing.rows[0].id, isNew: false });
    return;
  }

  // Create new DM conversation — set is_group explicitly so this row never
  // falls into the "legacy NULL" bucket and stays distinguishable from
  // group conversations going forward.
  const [convo] = await db.insert(conversations).values({ isGroup: false }).returning();

  await db.insert(conversationParticipants).values([
    { conversationId: convo.id, userId },
    { conversationId: convo.id, userId: otherUserId },
  ]);

  res.json({ conversationId: convo.id, isNew: true });
});

// ── Mark all DM + group conversations as read ─────────────────────────────
// Used by the bell's DMs tab "Mark read" action so clearing DM notifications
// also clears the Chat tab's aggregate unread state.
router.put('/conversations/mark-all-read', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  await db
    .update(conversationParticipants)
    .set({ lastReadAt: new Date() })
    .where(eq(conversationParticipants.userId, userId));
  res.json({ ok: true });
});

// ── Get messages in a DM conversation ─────────────────────────────────────
router.get('/conversations/:id/messages', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const convId = parseInt(req.params.id as string);

  // Parse aroundMessageId params first — validation error is cheapest to return
  const aroundParse = aroundMessageSchema.safeParse(req.query);
  if (!aroundParse.success) {
    res.status(400).json({ error: aroundParse.error.errors[0].message });
    return;
  }
  const { aroundMessageId, before: beforeCount, after: afterCount } = aroundParse.data;

  const cursor = req.query.before && !aroundMessageId
    ? new Date(req.query.before as string)
    : undefined;
  const limit = Math.min(parseInt(req.query.limit as string ?? '50'), 100);

  // Verify user is active participant (not left/kicked)
  const participation = await db
    .select()
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, convId),
        eq(conversationParticipants.userId, userId),
        isNull(conversationParticipants.leftAt)
      )
    )
    .limit(1);

  // Phase 12 D-09: public, non-archived groups allow read-only preview for
  // non-members so the in-place "Join Community" UX can render message history.
  let isPreviewRead = false;
  if (participation.length === 0) {
    const [convo] = await db
      .select({
        isGroup: conversations.isGroup,
        isPublic: conversations.isPublic,
        archivedAt: conversations.archivedAt,
      })
      .from(conversations)
      .where(eq(conversations.id, convId))
      .limit(1);

    if (!convo || !convo.isGroup || !convo.isPublic || convo.archivedAt !== null) {
      res.status(403).json({ error: 'Not a participant in this conversation' });
      return;
    }

    isPreviewRead = true;
  }

  // Update last read (skip for non-member preview reads — no participant row).
  if (!isPreviewRead) {
    await db
      .update(conversationParticipants)
      .set({ lastReadAt: new Date() })
      .where(
        and(
          eq(conversationParticipants.conversationId, convId),
          eq(conversationParticipants.userId, userId)
        )
      );
  }

  // ── aroundMessageId path (D-04) ────────────────────────────────────────────
  // Returns up to `before` older messages + target + up to `after` newer
  // messages in chronological order. Authorization already ran above.
  if (aroundMessageId !== undefined) {
    // Fetch target row — must exist, belong to this conversation, and not be deleted
    const [target] = await db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        createdAt: messages.createdAt,
        deletedAt: messages.deletedAt,
      })
      .from(messages)
      .where(eq(messages.id, aroundMessageId))
      .limit(1);

    // T-14-03-I-grinding: mismatch or missing → 404 (no oracle for cross-chat existence)
    if (
      !target ||
      target.conversationId !== convId ||
      target.deletedAt !== null
    ) {
      res.status(404).json({ error: 'message not found' });
      return;
    }

    const msgSelect = {
      id: messages.id,
      content: messages.content,
      createdAt: messages.createdAt,
      editedAt: messages.editedAt,
      senderId: messages.senderId,
      senderName: users.name,
      senderHandle: userProfiles.handle,
      senderAvatar: userProfiles.avatarUrl,
      mentions: messages.mentions,
      mediaUrls: messages.mediaUrls,
      kind: messages.kind,
    } as const;

    const targetCreatedAt = target.createdAt as Date;
    const targetId = target.id;

    // Two parallel queries — (created_at, id) keyset for tie-breaking.
    // JS Date.toISOString() truncates to ms but Postgres timestamptz stores µs;
    // the explicit ne(id) guards against the target row slipping into either
    // half due to the precision mismatch (target is concat'd separately below).
    const [olderRows, newerRows] = await Promise.all([
      db
        .select(msgSelect)
        .from(messages)
        .leftJoin(users, eq(users.id, messages.senderId))
        .leftJoin(userProfiles, eq(userProfiles.userId, messages.senderId))
        .where(
          and(
            eq(messages.conversationId, convId),
            isNull(messages.deletedAt),
            ne(messages.id, targetId),
            sql`(${messages.createdAt}, ${messages.id}) < (${targetCreatedAt.toISOString()}::timestamptz, ${targetId})`,
          ),
        )
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(beforeCount),
      db
        .select(msgSelect)
        .from(messages)
        .leftJoin(users, eq(users.id, messages.senderId))
        .leftJoin(userProfiles, eq(userProfiles.userId, messages.senderId))
        .where(
          and(
            eq(messages.conversationId, convId),
            isNull(messages.deletedAt),
            ne(messages.id, targetId),
            sql`(${messages.createdAt}, ${messages.id}) > (${targetCreatedAt.toISOString()}::timestamptz, ${targetId})`,
          ),
        )
        .orderBy(messages.createdAt, messages.id)
        .limit(afterCount),
    ]);

    // Fetch target row in full projection shape
    const [targetFull] = await db
      .select(msgSelect)
      .from(messages)
      .leftJoin(users, eq(users.id, messages.senderId))
      .leftJoin(userProfiles, eq(userProfiles.userId, messages.senderId))
      .where(eq(messages.id, aroundMessageId))
      .limit(1);

    // Reverse older (DESC→ASC) then concat: [...older, target, ...newer]
    const window = [...olderRows.reverse(), targetFull, ...newerRows];
    const withReactions = await attachReactions(window, userId);
    const withReplies = await attachReplyTo(withReactions);
    res.json({ messages: withReplies });
    return;
  }

  // ── Existing pagination path (unchanged) ──────────────────────────────────
  const query = db
    .select({
      id: messages.id,
      content: messages.content,
      createdAt: messages.createdAt,
      editedAt: messages.editedAt,
      senderId: messages.senderId,
      senderName: users.name,
      senderHandle: userProfiles.handle,
      senderAvatar: userProfiles.avatarUrl,
      mentions: messages.mentions,
      mediaUrls: messages.mediaUrls,
      kind: messages.kind,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.senderId))
    .leftJoin(userProfiles, eq(userProfiles.userId, messages.senderId))
    .where(
      cursor
        ? and(eq(messages.conversationId, convId), lt(messages.createdAt, cursor))
        : eq(messages.conversationId, convId)
    )
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  const rows = await query;
  const withReactions = await attachReactions(rows, userId);
  const withReplies = await attachReplyTo(withReactions);
  res.json({ messages: withReplies.reverse(), hasMore: rows.length === limit });
});

// ── Hide a DM conversation ───────────────────────────────────────────────
router.put('/conversations/:id/hide', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const convId = parseInt(req.params.id as string);

  if (isNaN(convId)) {
    res.status(400).json({ error: 'Invalid conversation ID' });
    return;
  }

  // Verify user is participant
  const participation = await db
    .select({ id: conversationParticipants.id })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, convId),
        eq(conversationParticipants.userId, userId)
      )
    )
    .limit(1);

  if (participation.length === 0) {
    res.status(403).json({ error: 'Not a participant in this conversation' });
    return;
  }

  await db
    .update(conversationParticipants)
    .set({ hiddenAt: new Date() })
    .where(
      and(
        eq(conversationParticipants.conversationId, convId),
        eq(conversationParticipants.userId, userId)
      )
    );

  res.json({ ok: true });
});

// ── Get recent location-based (room) chat history ─────────────────────────
router.get('/room/:roomId/messages', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const roomId = req.params.roomId as string;

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
  const limit = Math.min(parseInt(req.query.limit as string ?? '50'), 100);

  // Get blocked user IDs to exclude their messages
  const blockedRows = await db
    .select({ blockedUserId: blockedUsers.blockedUserId })
    .from(blockedUsers)
    .where(eq(blockedUsers.userId, userId));
  const blockedIds = blockedRows.map((r) => r.blockedUserId);

  // ── aroundMessageId path (D-04) ────────────────────────────────────────────
  if (aroundMessageId !== undefined) {
    // Fetch target row — must exist, belong to this roomId, and not be deleted
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
      editedAt: messages.editedAt,
      senderId: messages.senderId,
      senderName: users.name,
      senderHandle: userProfiles.handle,
      senderAvatar: userProfiles.avatarUrl,
      mentions: messages.mentions,
      mediaUrls: messages.mediaUrls,
      kind: messages.kind,
    } as const;

    const targetCreatedAt = target.createdAt as Date;
    const targetId = target.id;

    // Build blocked-sender exclusion for before/after queries.
    // ne(id, targetId) guards against the target slipping into either half due
    // to JS-ms-vs-pg-µs precision mismatch in the keyset boundary value.
    const blockedClauseOlder = blockedIds.length > 0
      ? and(
          eq(messages.roomId, roomId),
          isNull(messages.deletedAt),
          ne(messages.id, targetId),
          sql`(${messages.createdAt}, ${messages.id}) < (${targetCreatedAt.toISOString()}::timestamptz, ${targetId})`,
          notInArray(messages.senderId, blockedIds),
        )
      : and(
          eq(messages.roomId, roomId),
          isNull(messages.deletedAt),
          ne(messages.id, targetId),
          sql`(${messages.createdAt}, ${messages.id}) < (${targetCreatedAt.toISOString()}::timestamptz, ${targetId})`,
        );

    const blockedClauseNewer = blockedIds.length > 0
      ? and(
          eq(messages.roomId, roomId),
          isNull(messages.deletedAt),
          ne(messages.id, targetId),
          sql`(${messages.createdAt}, ${messages.id}) > (${targetCreatedAt.toISOString()}::timestamptz, ${targetId})`,
          notInArray(messages.senderId, blockedIds),
        )
      : and(
          eq(messages.roomId, roomId),
          isNull(messages.deletedAt),
          ne(messages.id, targetId),
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

    // Fetch target in full projection shape (blocked filter does not apply to target itself)
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

  // ── Existing pagination path (unchanged) ──────────────────────────────────
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
      editedAt: messages.editedAt,
      senderId: messages.senderId,
      senderName: users.name,
      senderHandle: userProfiles.handle,
      senderAvatar: userProfiles.avatarUrl,
      mentions: messages.mentions,
      mediaUrls: messages.mediaUrls,
      kind: messages.kind,
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

const translateSchema = z.object({
  targetLanguage: z.string().min(1).max(50).default('English'),
});

const editMessageSchema = z.object({
  content: z.string().min(1, 'Message cannot be empty').max(2000),
});

// ── Translate message ─────────────────────────────────────────────────────
router.post(
  '/translate/:messageId',
  requireCapability('canTranslateMessages'),
  async (req: AuthRequest, res: Response): Promise<void> => {
  const messageId = parseInt(req.params.messageId as string);
  if (isNaN(messageId)) {
    res.status(400).json({ error: 'Invalid message ID' });
    return;
  }

  const parse = translateSchema.safeParse(req.body);
  const targetLanguage = parse.success ? parse.data.targetLanguage : 'English';

  try {
    const [msg] = await db
      .select({ id: messages.id, content: messages.content, translatedContent: messages.translatedContent })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);

    if (!msg) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    if (!msg.content) {
      res.status(422).json({ error: 'No text content to translate' });
      return;
    }

    // Check cache (stored as JSON: { "English": "...", "Hebrew": "..." })
    let cached: Record<string, string> = {};
    if (msg.translatedContent) {
      try {
        cached = JSON.parse(msg.translatedContent);
      } catch {
        cached = {};
      }
    }

    if (cached[targetLanguage]) {
      res.json({ translation: cached[targetLanguage], cached: true });
      return;
    }

    // Translate and cache
    const translation = await translateMessage(msg.content, targetLanguage);
    cached[targetLanguage] = translation;
    await db
      .update(messages)
      .set({ translatedContent: JSON.stringify(cached) })
      .where(eq(messages.id, messageId));

    res.json({ translation, cached: false });
  } catch (err) {
    log.error({ err, messageId }, 'Translation failed');
    res.status(500).json({ error: 'Translation failed' });
  }
  }
);

// ── Edit message ─────────────────────────────────────────────────────────────
router.patch('/messages/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // 1. Parse and validate message ID
    const messageId = parseInt(req.params.id as string);
    if (isNaN(messageId)) {
      res.status(400).json({ error: 'Invalid message ID' });
      return;
    }

    // 2. Validate body
    const parse = editMessageSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.errors[0].message });
      return;
    }

    // 3. Trim and check for whitespace-only
    const content = parse.data.content.trim();
    if (!content) {
      res.status(400).json({ error: 'Message cannot be empty' });
      return;
    }

    // 4. Fetch existing message
    const [msg] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);

    if (!msg) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    // 5. Authorization: only owner can edit
    if (msg.senderId !== req.user!.id) {
      res.status(403).json({ error: 'You can only edit your own messages' });
      return;
    }

    // 6. Media guard: text-only edits in v1
    if (Array.isArray(msg.mediaUrls) && msg.mediaUrls.length > 0) {
      res.status(422).json({ error: 'Edits are not supported on media messages yet' });
      return;
    }

    // 7. Moderation re-run on new content
    const modResult = moderateMessage(content);
    if (!modResult.isAllowed) {
      console.error('[chat/edit]', { messageId, userId: req.user!.id, reason: modResult.reason });
      res.status(422).json({ error: modResult.reason ?? 'Content rejected by moderation' });
      return;
    }

    // 8. Transaction: audit insert + message update
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.insert(messageEdits).values({
        messageId: msg.id,
        content: msg.content,  // preserve OLD content in audit
        editedAt: now,
      });
      await tx.update(messages)
        .set({ content, editedAt: now })
        .where(eq(messages.id, msg.id));
    });

    // 9. Fetch updated row in GET-handler projection shape
    const [updatedRows] = await db
      .select({
        id: messages.id,
        content: messages.content,
        createdAt: messages.createdAt,
        editedAt: messages.editedAt,
        senderId: messages.senderId,
        senderName: users.name,
        senderHandle: userProfiles.handle,
        senderAvatar: userProfiles.avatarUrl,
        mentions: messages.mentions,
        mediaUrls: messages.mediaUrls,
        kind: messages.kind,
      })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.senderId))
      .leftJoin(userProfiles, eq(userProfiles.userId, messages.senderId))
      .where(eq(messages.id, msg.id))
      .limit(1);

    const withReactions = await attachReactions([updatedRows], req.user!.id);
    const withReplies = await attachReplyTo(withReactions);
    const updatedMessage = withReplies[0];

    // 10. Socket broadcast to the correct room
    const io = req.app.get('io') as Server | undefined;
    if (io) {
      const payload = {
        messageId: msg.id,
        content,
        editedAt: now.toISOString(),
        roomId: msg.roomId,
        conversationId: msg.conversationId,
      };
      if (msg.conversationId != null) {
        io.to(`conversation:${msg.conversationId}`).emit('message:edited', payload);
      } else if (msg.roomId != null) {
        io.to(msg.roomId).emit('message:edited', payload);
      }
    }

    // 11. Return updated message
    res.json({ message: updatedMessage });
  } catch (err) {
    console.error('[chat/edit]', err);
    res.status(500).json({ error: 'Edit failed' });
  }
});

// ── Message search: GET /api/chat/search?q=<query>&cursor=<opaque> ──────────
// SRCH-01: cross-source authorization via UNION ALL CTE across DMs, joined
// groups, joined Globe rooms, and Local Chat (timezone rooms). Requires
// pg_trgm GIN index on messages.content (Plan 14-01).
//
// Security: raw q is NEVER logged (PII gate T-14-02-I-pii). All $params are
// bound via Drizzle sql`` template (parameterized — T-14-02-T-q). Blocked
// users are excluded inline (T-14-02-I-block). Authorization is join-based,
// not pre-computed (T-14-02-I-auth). Rate-limited 30/min per user (T-14-02-D-dos).
router.get('/search', searchLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const startedAt = Date.now();
  const userId = req.user!.id;

  // 1. Validate query params
  const parse = searchQuerySchema.safeParse(req.query);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  // 2. Trim + 3-char gate (D-03)
  const q = parse.data.q.trim();
  if (q.length < 3) {
    res.status(400).json({ error: 'query too short' });
    return;
  }

  // 3. Cursor decode (D-02)
  let cursorData: { createdAt: string; id: number } | null = null;
  if (parse.data.cursor) {
    cursorData = decodeCursor(parse.data.cursor);
    if (cursorData === null) {
      res.status(400).json({ error: 'invalid cursor' });
      return;
    }
  }

  try {
    // 4. Execute UNION ALL CTE via raw sql template (D-07, RESEARCH Q12).
    //    RESEARCH delta #8: room_id uses prefixes 'globe:slug' and 'timezone:tz',
    //    so joins must prepend the prefix when matching against the memberships tables.
    //
    //    The outer SELECT joins users + user_profiles for senderHandle, and
    //    conversations for chatTitle resolution on dm/group rows.
    //    A correlated subquery resolves the "other participant" handle for DM rows.
    const ilikePat = `%${q}%`;

    const rows = await db.execute(sql`
      WITH authorized_messages AS (
        -- DMs and groups: messages where the requester is a current participant
        SELECT
          m.id,
          m.content,
          m.created_at,
          m.sender_id,
          m.conversation_id,
          m.room_id,
          'dm_or_group' AS auth_source
        FROM messages m
        JOIN conversation_participants cp
          ON cp.conversation_id = m.conversation_id
        WHERE cp.user_id = ${userId}
          AND cp.left_at IS NULL
          AND m.deleted_at IS NULL

        UNION ALL

        -- Globe rooms: messages in rooms the requester has a membership row for
        -- RESEARCH delta #8: room_id uses 'globe:' prefix
        SELECT
          m.id,
          m.content,
          m.created_at,
          m.sender_id,
          NULL::integer AS conversation_id,
          m.room_id,
          'globe_room' AS auth_source
        FROM messages m
        JOIN globe_room_memberships grm
          ON ('globe:' || grm.room_slug) = m.room_id
        WHERE grm.user_id = ${userId}
          AND m.deleted_at IS NULL

        UNION ALL

        -- Local Chat: messages in the requester's own timezone room
        -- RESEARCH delta #8: room_id uses 'timezone:' prefix
        SELECT
          m.id,
          m.content,
          m.created_at,
          m.sender_id,
          NULL::integer AS conversation_id,
          m.room_id,
          'local_chat' AS auth_source
        FROM messages m
        JOIN user_profiles up
          ON ('timezone:' || up.timezone) = m.room_id
        WHERE up.user_id = ${userId}
          AND m.deleted_at IS NULL
      )
      SELECT
        am.id,
        am.content,
        am.created_at,
        am.sender_id,
        am.conversation_id,
        am.room_id,
        am.auth_source,
        sup.handle AS sender_handle,
        c.is_group,
        c.group_name,
        (
          SELECT up2.handle
          FROM conversation_participants cp2
          JOIN user_profiles up2 ON up2.user_id = cp2.user_id
          WHERE cp2.conversation_id = am.conversation_id
            AND cp2.user_id != ${userId}
          LIMIT 1
        ) AS other_handle
      FROM authorized_messages am
      JOIN users u ON u.id = am.sender_id
      LEFT JOIN user_profiles sup ON sup.user_id = u.id
      LEFT JOIN conversations c ON c.id = am.conversation_id
      WHERE am.content ILIKE ${ilikePat}
        AND am.sender_id NOT IN (
          SELECT blocked_user_id FROM blocked_users WHERE user_id = ${userId}
        )
        ${cursorData
          ? sql`AND (am.created_at, am.id) < (${cursorData.createdAt}::timestamptz, ${cursorData.id})`
          : sql``
        }
      ORDER BY am.created_at DESC, am.id DESC
      LIMIT 25
    `);

    // 5. Map raw rows → SearchResult[] with server-resolved chatTitle (D-06)
    const results: SearchResult[] = (rows.rows as Array<{
      id: number;
      content: string;
      created_at: Date;
      sender_id: number;
      conversation_id: number | null;
      room_id: string | null;
      auth_source: string;
      sender_handle: string | null;
      is_group: boolean | null;
      group_name: string | null;
      other_handle: string | null;
    }>).map((row) => {
      const senderHandle = row.sender_handle ?? 'unknown';
      const createdAt = row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at);

      // Determine source from row data
      if (row.conversation_id != null) {
        const isGroup = row.is_group === true;
        if (isGroup) {
          // Group chat
          const chatTitle = row.group_name ?? 'Group';
          return {
            source: 'group' as const,
            messageId: row.id,
            content: row.content,
            createdAt,
            senderHandle,
            chatTitle,
            entityId: row.conversation_id,
            conversationId: row.conversation_id,
          };
        } else {
          // 1-on-1 DM — chatTitle = other participant's @handle
          const otherHandle = row.other_handle ?? 'unknown';
          const chatTitle = `@${otherHandle}`;
          return {
            source: 'dm' as const,
            messageId: row.id,
            content: row.content,
            createdAt,
            senderHandle,
            chatTitle,
            entityId: row.conversation_id,
            conversationId: row.conversation_id,
          };
        }
      } else if (row.room_id?.startsWith('globe:')) {
        // Globe room — chatTitle = #DisplayName from GLOBE_ROOMS config
        const slug = row.room_id.replace(/^globe:/, '');
        const displayName = GLOBE_ROOMS.find((r) => r.slug === slug)?.displayName ?? slug;
        const chatTitle = `#${displayName}`;
        return {
          source: 'globe_room' as const,
          messageId: row.id,
          content: row.content,
          createdAt,
          senderHandle,
          chatTitle,
          entityId: slug,
          roomSlug: slug,
        };
      } else {
        // Local Chat (timezone room) — chatTitle = "Local · {city}"
        const iana = row.room_id?.replace(/^timezone:/, '') ?? '';
        // Extract city: last segment after the final '/' in the IANA string,
        // replace underscores with spaces (e.g. "America/New_York" → "New York")
        const city = iana.includes('/')
          ? iana.split('/').pop()!.replace(/_/g, ' ')
          : iana.replace(/_/g, ' ');
        const chatTitle = `Local · ${city}`;
        return {
          source: 'local_chat' as const,
          messageId: row.id,
          content: row.content,
          createdAt,
          senderHandle,
          chatTitle,
          entityId: iana,
          timezoneIana: iana,
        };
      }
    });

    // 6. Compute nextCursor: encode from last row if exactly 25 returned
    const lastRow = rows.rows[rows.rows.length - 1] as {
      id: number;
      created_at: Date;
    } | undefined;
    const nextCursor: string | null =
      rows.rows.length === 25 && lastRow
        ? encodeCursor(
            lastRow.created_at instanceof Date
              ? lastRow.created_at.toISOString()
              : String(lastRow.created_at),
            lastRow.id,
          )
        : null;

    // 7. Respond
    const response: SearchResponse = { results, nextCursor };
    res.json(response);

    // 8. Log per-request — NO raw q content (PII gate T-14-02-I-pii)
    log.info(
      { userId, qLength: q.length, resultsCount: results.length, durationMs: Date.now() - startedAt },
      '[search]',
    );
  } catch (err) {
    log.error({ err, userId }, '[search] error');
    res.status(500).json({ error: 'search failed' });
  }
});

export default router;
