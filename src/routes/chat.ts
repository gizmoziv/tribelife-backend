import { Router, Response } from 'express';
import { eq, and, inArray, desc, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import {
  conversations,
  conversationParticipants,
  messages,
  users,
  userProfiles,
} from '../db/schema';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

// ── List DM conversations for current user ─────────────────────────────────
router.get('/conversations', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;

  // Get all conversations the user participates in
  const participations = await db
    .select({ conversationId: conversationParticipants.conversationId })
    .from(conversationParticipants)
    .where(eq(conversationParticipants.userId, userId));

  if (participations.length === 0) {
    res.json({ conversations: [] });
    return;
  }

  const convIds = participations.map((p) => p.conversationId);

  // For each conversation, get the other participant + last message
  const result = await db
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
    .where(inArray(conversations.id, convIds))
    .orderBy(desc(conversations.lastMessageAt));

  // Attach last message preview
  const convosWithPreview = await Promise.all(
    result.map(async (row) => {
      const [lastMsg] = await db
        .select({ content: messages.content, createdAt: messages.createdAt })
        .from(messages)
        .where(eq(messages.conversationId, row.conversationId))
        .orderBy(desc(messages.createdAt))
        .limit(1);

      return { ...row, lastMessage: lastMsg ?? null };
    })
  );

  res.json({ conversations: convosWithPreview });
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
  const convId = parseInt(req.params.id);
  const cursor = req.query.before ? new Date(req.query.before as string) : undefined;
  const limit = Math.min(parseInt(req.query.limit as string ?? '50'), 100);

  // Verify user is participant
  const participation = await db
    .select()
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
  res.json({ messages: rows.reverse(), hasMore: rows.length === limit });
});

// ── Get recent location-based (room) chat history ─────────────────────────
router.get('/room/:roomId/messages', async (req: AuthRequest, res: Response): Promise<void> => {
  const { roomId } = req.params;
  const cursor = req.query.before ? new Date(req.query.before as string) : undefined;
  const limit = Math.min(parseInt(req.query.limit as string ?? '50'), 100);

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
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.senderId))
    .leftJoin(userProfiles, eq(userProfiles.userId, messages.senderId))
    .where(
      cursor
        ? and(eq(messages.roomId, roomId), lt(messages.createdAt, cursor))
        : eq(messages.roomId, roomId)
    )
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  res.json({ messages: rows.reverse(), hasMore: rows.length === limit });
});

export default router;
