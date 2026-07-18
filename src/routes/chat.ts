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
import { redactDeletedMessages } from '../utils/redactDeleted';
import { attachReplyTo } from '../utils/attachReplyTo';
import { translateMessage } from '../services/translation';
import { moderateMessage } from '../services/claude';
import { logModerationEvent } from '../lib/moderationLog';
import { moderationEnforced } from '../lib/moderationEnforcement';
import { getIO } from '../lib/socketRegistry';
import { emitReadForConversation, emitReadForConversations } from '../socket/receipts';
import { isUserBanned } from '../lib/bannedUsers';
import type { Server } from 'socket.io';
import logger from '../lib/logger';
import type { SearchResult, SearchResponse } from '../types/searchResult';
import { GLOBE_ROOMS } from '../config/globeRooms';
import { TIMEZONE_ZONES, translateLegacyTimezoneRoomId } from '../config/timezoneZones';

const log = logger.child({ module: 'chat' });

// Phase 15 (D-01): Pre-built SQL CASE expression mapping IANA → zone-slug-prefixed
// room id. Used by the search UNION CTE's `local_chat` branch to authorize a
// requester's local-chat messages against their consolidated zone room
// (e.g. America/New_York → timezone:eastern-time). RESEARCH §G2 Note + §10
// Question 6. Built once at module load; TIMEZONE_ZONES is a constant.
const TIMEZONE_TO_ROOM_ID_CASE_SQL: string = (() => {
  const branches = TIMEZONE_ZONES.flatMap((z) =>
    z.members.map((iana) => `WHEN '${iana}' THEN 'timezone:${z.slug}'`),
  ).join(' ');
  return `CASE up.timezone ${branches} ELSE 'timezone:utc' END`;
})();

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
// Phase 14 D-04: around-message window schema.
// IMPORTANT: existing `?before=<ISO timestamp>` is the OLDER-MESSAGES cursor.
// We reuse `before` as a COUNT only when aroundMessageId is present. To avoid
// the timestamp string failing z.coerce.number(), accept either a coercible
// number OR pass through (default applied at destructure) when not numeric.
// Bug: prior schema unconditionally coerced before/after → existing
// /messages?before=<iso> calls 400'd with "Expected number, received nan".
const beforeAfterCount = z
  .union([z.coerce.number().int().min(0).max(50), z.string()])
  .optional()
  .transform((v) => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    return undefined;
  });

const aroundMessageSchema = z.object({
  aroundMessageId: z.coerce.number().int().positive().optional(),
  before: beforeAfterCount,
  after: beforeAfterCount,
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
      // Drizzle interpolates `${conversations.id}` as bare `"id"` which PG
      // resolves against the inner scope (cp.id), silently miscounting.
      // Use explicit `conversations.id` reference inline.
      memberCount: sql<number>`(SELECT count(*)::int FROM conversation_participants cp WHERE cp.conversation_id = conversations.id AND cp.left_at IS NULL)`,
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

  if (await isUserBanned(otherUserId)) {
    res.status(404).json({ error: 'User not found' });
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

  // Emit message:read for every read-advanced conversation (RCPT-06/07). The
  // bulk update has no convId param, so resolve the user's active conversations
  // and let the helper apply the per-conversation DM/group privacy gate.
  const io = getIO();
  if (io) {
    const active = await db
      .select({ conversationId: conversationParticipants.conversationId })
      .from(conversationParticipants)
      .where(and(
        eq(conversationParticipants.userId, userId),
        isNull(conversationParticipants.leftAt),
      ));
    await emitReadForConversations(io, active.map((r) => r.conversationId), userId)
      .catch((err) => console.error('[receipts/read]', err));
  }

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
  const { aroundMessageId, before: beforeRaw, after: afterRaw } = aroundParse.data;
  // Default to 25 when caller omitted the count or sent a non-numeric value
  // (e.g. ?before=<ISO> for the existing older-cursor pagination path).
  const beforeCount = typeof beforeRaw === 'number' ? beforeRaw : 25;
  const afterCount = typeof afterRaw === 'number' ? afterRaw : 25;

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

    // Read state advanced → emit message:read (RCPT-06/07). Only inside this
    // branch: a non-member preview read advances no watermark and emits nothing.
    const io = getIO();
    if (io) {
      await emitReadForConversation(io, convId, userId)
        .catch((err) => console.error('[receipts/read]', err));
    }
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
      attachments: messages.attachments,
      kind: messages.kind,
      voiceUrl: messages.voiceUrl,
      voiceDurationMs: messages.voiceDurationMs,
      voiceWaveform: messages.voiceWaveform,
      voiceTranscript: messages.voiceTranscript,
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
      deletedAt: messages.deletedAt,
      senderId: messages.senderId,
      senderName: users.name,
      senderHandle: userProfiles.handle,
      senderAvatar: userProfiles.avatarUrl,
      mentions: messages.mentions,
      mediaUrls: messages.mediaUrls,
      attachments: messages.attachments,
      kind: messages.kind,
      voiceUrl: messages.voiceUrl,
      voiceDurationMs: messages.voiceDurationMs,
      voiceWaveform: messages.voiceWaveform,
      voiceTranscript: messages.voiceTranscript,
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

  // Keep soft-deleted rows so the client shows a persistent tombstone in place;
  // redactDeletedMessages strips their content before it leaves the server.
  const rows = redactDeletedMessages(await query);
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

// ── Archive a DM or group conversation for the caller ─────────────────────
router.put('/conversations/:id/archive', async (req: AuthRequest, res: Response): Promise<void> => {
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
    .set({ archivedAt: new Date() })
    .where(
      and(
        eq(conversationParticipants.conversationId, convId),
        eq(conversationParticipants.userId, userId)
      )
    );

  res.json({ ok: true });
});

// ── Unarchive a DM or group conversation for the caller ───────────────────
router.put('/conversations/:id/unarchive', async (req: AuthRequest, res: Response): Promise<void> => {
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
    .set({ archivedAt: null })
    .where(
      and(
        eq(conversationParticipants.conversationId, convId),
        eq(conversationParticipants.userId, userId)
      )
    );

  res.json({ ok: true });
});

// ── Mute a DM or group conversation for the caller ────────────────────────
router.put('/conversations/:id/mute', async (req: AuthRequest, res: Response): Promise<void> => {
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
    .set({ mutedAt: new Date() })
    .where(
      and(
        eq(conversationParticipants.conversationId, convId),
        eq(conversationParticipants.userId, userId)
      )
    );

  res.json({ ok: true });
});

// ── Unmute a DM or group conversation for the caller ──────────────────────
router.put('/conversations/:id/unmute', async (req: AuthRequest, res: Response): Promise<void> => {
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
    .set({ mutedAt: null })
    .where(
      and(
        eq(conversationParticipants.conversationId, convId),
        eq(conversationParticipants.userId, userId)
      )
    );

  res.json({ ok: true });
});

// ── List conversation participants with receipt watermarks (D-01a) ────────
// Additive, read-only. Lets the mobile client seed receiptsStore on cold open
// so own-message Delivered/Read ticks render immediately for DM threads.
// Old clients never call it. Membership-gated (V4): only active participants
// may read other participants' watermarks.
router.get('/conversations/:id/participants', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const convId = parseInt(req.params.id as string);

  if (isNaN(convId)) {
    res.status(400).json({ error: 'Invalid conversation ID' });
    return;
  }

  // Verify caller is an active participant (mirror the messages route's gate).
  const participation = await db
    .select({ id: conversationParticipants.id })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, convId),
        eq(conversationParticipants.userId, userId),
        isNull(conversationParticipants.leftAt)
      )
    )
    .limit(1);

  if (participation.length === 0) {
    res.status(403).json({ error: 'Not a participant of this conversation' });
    return;
  }

  const participants = await db
    .select({
      userId: conversationParticipants.userId,
      lastDeliveredAt: conversationParticipants.lastDeliveredAt,
      lastReadAt: conversationParticipants.lastReadAt,
    })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, convId),
        isNull(conversationParticipants.leftAt)
      )
    );

  res.json({ participants });
});

// ── Get recent location-based (room) chat history ─────────────────────────
router.get('/room/:roomId/messages', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  // Backward-compat shim for clients on ≤v1.4.5 that still send roomIds in the
  // legacy `timezone:<IANA>` form. Phase 15 migration 0019 rewrote every
  // matching row in messages.room_id to the canonical `timezone:<slug>` form,
  // so an unshimmed query against the IANA value would return zero rows and
  // wipe the user's history on cold open. Logged so the operator can monitor
  // residual ≤1.4.5 traffic and decide when it's safe to remove this shim.
  const { roomId: rawRoomId } = req.params as { roomId: string };
  const { roomId, wasLegacy } = translateLegacyTimezoneRoomId(rawRoomId);
  if (wasLegacy) {
    logger.info(
      { userId, route: '/chat/room/:roomId/messages', original: rawRoomId, translated: roomId },
      '[shim:legacy-room-id] translated IANA → canonical slug for ≤1.4.5 client',
    );
  }

  // Parse aroundMessageId params — validation error is cheapest to return
  const aroundParse = aroundMessageSchema.safeParse(req.query);
  if (!aroundParse.success) {
    res.status(400).json({ error: aroundParse.error.errors[0].message });
    return;
  }
  const { aroundMessageId, before: beforeRaw, after: afterRaw } = aroundParse.data;
  // Default to 25 when caller omitted the count or sent a non-numeric value
  // (e.g. ?before=<ISO> for the existing older-cursor pagination path).
  const beforeCount = typeof beforeRaw === 'number' ? beforeRaw : 25;
  const afterCount = typeof afterRaw === 'number' ? afterRaw : 25;

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
      attachments: messages.attachments,
      kind: messages.kind,
      voiceUrl: messages.voiceUrl,
      voiceDurationMs: messages.voiceDurationMs,
      voiceWaveform: messages.voiceWaveform,
      voiceTranscript: messages.voiceTranscript,
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

  const rawRows = await db
    .select({
      id: messages.id,
      content: messages.content,
      createdAt: messages.createdAt,
      editedAt: messages.editedAt,
      deletedAt: messages.deletedAt,
      senderId: messages.senderId,
      senderName: users.name,
      senderHandle: userProfiles.handle,
      senderAvatar: userProfiles.avatarUrl,
      mentions: messages.mentions,
      mediaUrls: messages.mediaUrls,
      attachments: messages.attachments,
      kind: messages.kind,
      voiceUrl: messages.voiceUrl,
      voiceDurationMs: messages.voiceDurationMs,
      voiceWaveform: messages.voiceWaveform,
      voiceTranscript: messages.voiceTranscript,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.senderId))
    .leftJoin(userProfiles, eq(userProfiles.userId, messages.senderId))
    .where(whereClause)
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  // Keep soft-deleted rows (persistent tombstone) but strip their content.
  const rows = redactDeletedMessages(rawRows);
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
      .select({ id: messages.id, content: messages.content, translatedContent: messages.translatedContent, voiceUrl: messages.voiceUrl, voiceTranscript: messages.voiceTranscript })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);

    if (!msg) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    // Voice messages store the fallback string ("🎤 Voice message — update to
    // listen") in `content`; the meaningful text to translate is the Whisper
    // transcript. Text messages keep translating `content`.
    const sourceText = msg.voiceUrl ? msg.voiceTranscript : msg.content;
    if (!sourceText) {
      res.status(422).json({
        error: msg.voiceUrl ? 'No transcript available to translate yet' : 'No text content to translate',
      });
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
    const translation = await translateMessage(sourceText, targetLanguage);
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
      if (moderationEnforced()) {
        console.error('[chat/edit]', { messageId, userId: req.user!.id, reason: modResult.reason });
        logModerationEvent({ surface: 'text', action: 'rejected', reason: modResult.reason, senderId: req.user!.id, messageId });
        res.status(422).json({ error: modResult.reason ?? 'Content rejected by moderation' });
        return;
      }
      // Shadow mode: log what we would have blocked, then continue applying the edit.
      logModerationEvent({ surface: 'text', action: 'shadow_would_block', reason: modResult.reason, senderId: req.user!.id, messageId });
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
        attachments: messages.attachments,
        kind: messages.kind,
        voiceUrl: messages.voiceUrl,
        voiceDurationMs: messages.voiceDurationMs,
        voiceWaveform: messages.voiceWaveform,
        voiceTranscript: messages.voiceTranscript,
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

// ── Delete message (for everyone) ────────────────────────────────────────────
// Soft-delete: sets messages.deleted_at, which every read path already excludes
// via isNull(messages.deletedAt). Own-message-only (mirrors edit's 403 gate).
// Broadcasts `message:deleted` so live clients swap the bubble for a tombstone;
// on reload the row is simply filtered out. Reply-to previews are unaffected —
// they store a frozen snapshot captured at send time.
router.delete('/messages/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const messageId = parseInt(req.params.id as string);
    if (isNaN(messageId)) {
      res.status(400).json({ error: 'Invalid message ID' });
      return;
    }

    const [msg] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);

    if (!msg) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    // Authorization: only the author can delete their message.
    if (msg.senderId !== req.user!.id) {
      res.status(403).json({ error: 'You can only delete your own messages' });
      return;
    }

    // Idempotent: already deleted → succeed without re-broadcasting.
    if (msg.deletedAt != null) {
      res.json({ ok: true });
      return;
    }

    const now = new Date();
    await db
      .update(messages)
      .set({ deletedAt: now })
      .where(eq(messages.id, msg.id));

    // Broadcast to the correct room (same routing as message:edited).
    const io = req.app.get('io') as Server | undefined;
    if (io) {
      const payload = {
        messageId: msg.id,
        roomId: msg.roomId,
        conversationId: msg.conversationId,
        deletedAt: now.toISOString(),
      };
      if (msg.conversationId != null) {
        io.to(`conversation:${msg.conversationId}`).emit('message:deleted', payload);
      } else if (msg.roomId != null) {
        io.to(msg.roomId).emit('message:deleted', payload);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[chat/delete]', err);
    res.status(500).json({ error: 'Delete failed' });
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

  // 2. Trim + 3-char gate (D-03). Tokenize on whitespace and use each term
  // ≥3 chars as an AND-ed ILIKE clause so "hello world" matches content
  // containing "Hello Great World" (token-order-independent substring match).
  // Each ILIKE still lights up the messages_content_trgm_idx GIN index from
  // Plan 14-01 because trigrams index 3-char windows of `content`.
  const q = parse.data.q.trim();
  if (q.length < 3) {
    res.status(400).json({ error: 'query too short' });
    return;
  }
  const terms = q.split(/\s+/).filter((t) => t.length >= 3);
  if (terms.length === 0) {
    // e.g. "ab cd" — total length passes the 3-char gate but no individual
    // term is long enough to use the trigram index. Treat as too-short rather
    // than slow-falling-through to seq scan.
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
    //
    //    Multi-term search: build "am.content ILIKE %t1% AND am.content ILIKE %t2% AND ..."
    //    using sql.join so each term is a parameterized bind (no injection risk).
    const ilikeClauses = sql.join(
      terms.map((t) => sql`am.content ILIKE ${'%' + t + '%'}`),
      sql` AND `,
    );

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

        -- Local Chat: messages in the requester's own timezone room.
        -- Phase 15 (D-01): room_id uses canonical zone slug
        -- ('timezone:eastern-time'), not IANA. The CASE expression
        -- maps up.timezone (IANA) → 'timezone:<zone-slug>' so the join
        -- matches messages routed to the consolidated zone room.
        -- See RESEARCH §G2 Note + §10 Question 6.
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
          ON (${sql.raw(TIMEZONE_TO_ROOM_ID_CASE_SQL)}) = m.room_id
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
      WHERE ${ilikeClauses}
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
