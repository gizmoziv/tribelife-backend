import { Router, Response } from 'express';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { Server } from 'socket.io';
import { db } from '../db';
import { reactions, messages } from '../db/schema';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

// ── Toggle a reaction (add or remove) ─────────────────────────────────────
const toggleReactionSchema = z.object({
  messageId: z.number().int().positive(),
  emoji: z.string().min(1).max(20),
});

router.post('/toggle', async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = toggleReactionSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  const userId = req.user!.id;
  const { messageId, emoji } = parse.data;

  // Look up the message for broadcast target
  const [message] = await db
    .select({
      id: messages.id,
      roomId: messages.roomId,
      conversationId: messages.conversationId,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);

  if (!message) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }

  // Check if reaction already exists
  const [existing] = await db
    .select({ id: reactions.id })
    .from(reactions)
    .where(
      and(
        eq(reactions.messageId, messageId),
        eq(reactions.userId, userId),
        eq(reactions.emoji, emoji),
      )
    )
    .limit(1);

  const io = req.app.get('io') as Server;
  const roomName = message.roomId ?? `conversation:${message.conversationId}`;

  if (existing) {
    // Remove existing reaction
    await db.delete(reactions).where(eq(reactions.id, existing.id));
    io.to(roomName).emit('reaction:update', {
      messageId, emoji, userId,
      userHandle: req.user!.handle,
      action: 'remove',
      roomId: message.roomId ?? undefined,
      conversationId: message.conversationId ?? undefined,
    });
    res.json({ action: 'removed' });
  } else {
    // Add new reaction
    const [reaction] = await db
      .insert(reactions)
      .values({ messageId, userId, emoji })
      .returning();
    io.to(roomName).emit('reaction:update', {
      messageId, emoji, userId,
      userHandle: req.user!.handle,
      action: 'add',
      roomId: message.roomId ?? undefined,
      conversationId: message.conversationId ?? undefined,
    });
    res.status(201).json({ action: 'added', reaction: { id: reaction.id, messageId, userId, emoji, createdAt: reaction.createdAt } });
  }
});

// ── Add a reaction to a message ─────────────────────────────────────────────
const addReactionSchema = z.object({
  messageId: z.number().int().positive(),
  emoji: z.string().min(1).max(20),
});

router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = addReactionSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  const userId = req.user!.id;
  const { messageId, emoji } = parse.data;

  // Look up the message to get room/conversation for broadcast
  const [message] = await db
    .select({
      id: messages.id,
      roomId: messages.roomId,
      conversationId: messages.conversationId,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);

  if (!message) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }

  try {
    const [reaction] = await db
      .insert(reactions)
      .values({ messageId, userId, emoji })
      .returning();

    // Broadcast to the correct room
    const io = req.app.get('io') as Server;
    const roomName = message.roomId ?? `conversation:${message.conversationId}`;
    io.to(roomName).emit('reaction:update', {
      messageId,
      emoji,
      userId,
      userHandle: req.user!.handle,
      action: 'add',
      roomId: message.roomId ?? undefined,
      conversationId: message.conversationId ?? undefined,
    });

    res.status(201).json({
      reaction: {
        id: reaction.id,
        messageId: reaction.messageId,
        userId: reaction.userId,
        emoji: reaction.emoji,
        createdAt: reaction.createdAt,
      },
    });
  } catch (err: any) {
    // Unique constraint violation (same user+message+emoji)
    if (err?.code === '23505') {
      res.status(409).json({ error: 'Reaction already exists' });
      return;
    }
    console.error('[reactions] Failed to add reaction', err);
    res.status(500).json({ error: 'Failed to add reaction' });
  }
});

// ── Remove a reaction ───────────────────────────────────────────────────────
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid reaction id' });
    return;
  }

  const userId = req.user!.id;

  // Find the reaction
  const [reaction] = await db
    .select()
    .from(reactions)
    .where(eq(reactions.id, id))
    .limit(1);

  if (!reaction) {
    res.status(404).json({ error: 'Reaction not found' });
    return;
  }

  if (reaction.userId !== userId) {
    res.status(403).json({ error: 'Not your reaction' });
    return;
  }

  // Look up the parent message for broadcast target
  const [message] = await db
    .select({
      id: messages.id,
      roomId: messages.roomId,
      conversationId: messages.conversationId,
    })
    .from(messages)
    .where(eq(messages.id, reaction.messageId))
    .limit(1);

  await db.delete(reactions).where(eq(reactions.id, id));

  // Broadcast removal
  if (message) {
    const io = req.app.get('io') as Server;
    const roomName = message.roomId ?? `conversation:${message.conversationId}`;
    io.to(roomName).emit('reaction:update', {
      messageId: reaction.messageId,
      emoji: reaction.emoji,
      userId,
      userHandle: req.user!.handle,
      action: 'remove',
      roomId: message.roomId ?? undefined,
      conversationId: message.conversationId ?? undefined,
    });
  }

  res.json({ ok: true });
});

export default router;
