import { Router, Response } from 'express';
import { eq, and, inArray, desc, lt, sql, notInArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import {
  conversations,
  conversationParticipants,
  messages,
  users,
  userProfiles,
  blockedUsers,
} from '../db/schema';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { attachReactions } from '../utils/attachReactions';
import { attachReplyTo } from '../utils/attachReplyTo';
import { translateMessage } from '../services/translation';
import logger from '../lib/logger';

const log = logger.child({ module: 'chat' });

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

      return { ...row, lastMessage: lastMsg ?? null, isGroup: false as const };
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

  // Check if a 1-on-1 conversation already exists between these two users
  const existing = await db.execute(sql`
    SELECT c.id
    FROM conversations c
    WHERE (
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

  // Create new conversation
  const [convo] = await db.insert(conversations).values({}).returning();

  await db.insert(conversationParticipants).values([
    { conversationId: convo.id, userId },
    { conversationId: convo.id, userId: otherUserId },
  ]);

  res.json({ conversationId: convo.id, isNew: true });
});

// ── Get messages in a DM conversation ─────────────────────────────────────
router.get('/conversations/:id/messages', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const convId = parseInt(req.params.id as string);
  const cursor = req.query.before ? new Date(req.query.before as string) : undefined;
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

  if (participation.length === 0) {
    res.status(403).json({ error: 'Not a participant in this conversation' });
    return;
  }

  // Update last read
  await db
    .update(conversationParticipants)
    .set({ lastReadAt: new Date() })
    .where(
      and(
        eq(conversationParticipants.conversationId, convId),
        eq(conversationParticipants.userId, userId)
      )
    );

  const query = db
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

const translateSchema = z.object({
  targetLanguage: z.string().min(1).max(50).default('English'),
});

// ── Translate message ─────────────────────────────────────────────────────
router.post('/translate/:messageId', async (req: AuthRequest, res: Response): Promise<void> => {
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
});

export default router;
