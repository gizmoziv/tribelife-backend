import { Router, Response } from 'express';
import { eq, and, sql, isNull, asc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import {
  conversations,
  conversationParticipants,
  users,
  userProfiles,
} from '../db/schema';
import { requireAuth, AuthRequest } from '../middleware/auth';
import logger from '../lib/logger';

const log = logger.child({ module: 'groups' });

const router = Router();
router.use(requireAuth);

function generateSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${base}-${rand}`;
}

// ── Create Group ────────────────────────────────────────────────────────────
const createGroupSchema = z.object({
  name: z.string().min(1).max(50),
  slug: z.string().min(1).max(50).optional(),
});

router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;

  if (!req.user!.isPremium) {
    res.status(403).json({ error: 'Premium subscription required to create groups' });
    return;
  }

  const parse = createGroupSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'Invalid input', details: parse.error.flatten() });
    return;
  }

  const { name } = parse.data;
  let slug = parse.data.slug ?? generateSlug(name);

  // Validate slug uniqueness
  const existing = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.inviteSlug, slug))
    .limit(1);

  if (existing.length > 0) {
    if (parse.data.slug) {
      res.status(400).json({ error: 'Slug already taken' });
      return;
    }
    // Auto-generated slug collision — regenerate
    slug = generateSlug(name);
  }

  try {
    const [convo] = await db
      .insert(conversations)
      .values({
        isGroup: true,
        groupName: name,
        inviteSlug: slug,
        createdById: userId,
      })
      .returning();

    await db.insert(conversationParticipants).values({
      conversationId: convo.id,
      userId,
      role: 'admin',
    });

    res.json({
      conversation: {
        id: convo.id,
        groupName: convo.groupName,
        inviteSlug: convo.inviteSlug,
        createdAt: convo.createdAt,
      },
    });
  } catch (err) {
    log.error({ err }, 'Failed to create group');
    res.status(500).json({ error: 'Failed to create group' });
  }
});

// ── Get Group Info (invite preview) ─────────────────────────────────────────
router.get('/:slug', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const slug = req.params.slug as string;

  const [group] = await db
    .select({
      id: conversations.id,
      groupName: conversations.groupName,
      groupIconUrl: conversations.groupIconUrl,
      inviteSlug: conversations.inviteSlug,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .where(and(eq(conversations.inviteSlug, slug), eq(conversations.isGroup, true)))
    .limit(1);

  if (!group) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }

  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, group.id),
        isNull(conversationParticipants.leftAt)
      )
    );

  const [membership] = await db
    .select({ id: conversationParticipants.id, leftAt: conversationParticipants.leftAt })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, group.id),
        eq(conversationParticipants.userId, userId)
      )
    )
    .limit(1);

  const isMember = membership != null && membership.leftAt == null;

  res.json({
    group: {
      id: group.id,
      groupName: group.groupName,
      groupIconUrl: group.groupIconUrl,
      inviteSlug: group.inviteSlug,
      memberCount: countResult?.count ?? 0,
      createdAt: group.createdAt,
      isMember,
    },
  });
});

// ── Join Group ──────────────────────────────────────────────────────────────
router.post('/:slug/join', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const slug = req.params.slug as string;

  const [group] = await db
    .select({
      id: conversations.id,
      groupName: conversations.groupName,
      maxMembers: conversations.maxMembers,
    })
    .from(conversations)
    .where(and(eq(conversations.inviteSlug, slug), eq(conversations.isGroup, true)))
    .limit(1);

  if (!group) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }

  // Check if already a member
  const [existing] = await db
    .select({
      id: conversationParticipants.id,
      leftAt: conversationParticipants.leftAt,
    })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, group.id),
        eq(conversationParticipants.userId, userId)
      )
    )
    .limit(1);

  if (existing && !existing.leftAt) {
    res.status(400).json({ error: 'Already a member of this group' });
    return;
  }

  // Check max members
  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, group.id),
        isNull(conversationParticipants.leftAt)
      )
    );

  if (countResult.count >= (group.maxMembers ?? 200)) {
    res.status(400).json({ error: 'Group is full' });
    return;
  }

  if (existing && existing.leftAt) {
    // Rejoin — clear leftAt
    await db
      .update(conversationParticipants)
      .set({ leftAt: null, hiddenAt: null })
      .where(eq(conversationParticipants.id, existing.id));
  } else {
    await db.insert(conversationParticipants).values({
      conversationId: group.id,
      userId,
      role: 'member',
    });
  }

  res.json({
    conversation: {
      id: group.id,
      groupName: group.groupName,
    },
  });
});

// ── Update Group ────────────────────────────────────────────────────────────
const updateGroupSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  slug: z.string().min(1).max(50).optional(),
  groupIconUrl: z.string().optional(),
});

router.put('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const convId = parseInt(req.params.id as string);

  if (isNaN(convId)) {
    res.status(400).json({ error: 'Invalid group ID' });
    return;
  }

  // Admin check
  const [participant] = await db
    .select({ role: conversationParticipants.role })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, convId),
        eq(conversationParticipants.userId, userId),
        isNull(conversationParticipants.leftAt)
      )
    )
    .limit(1);

  if (!participant || participant.role !== 'admin') {
    res.status(403).json({ error: 'Only group admins can update the group' });
    return;
  }

  const parse = updateGroupSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'Invalid input', details: parse.error.flatten() });
    return;
  }

  const updates: Partial<typeof conversations.$inferInsert> = {};
  if (parse.data.name) updates.groupName = parse.data.name;
  if (parse.data.groupIconUrl !== undefined) updates.groupIconUrl = parse.data.groupIconUrl;

  if (parse.data.slug) {
    const [slugExists] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.inviteSlug, parse.data.slug), sql`${conversations.id} != ${convId}`))
      .limit(1);

    if (slugExists) {
      res.status(400).json({ error: 'Slug already taken' });
      return;
    }
    updates.inviteSlug = parse.data.slug;
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'No updates provided' });
    return;
  }

  const [updated] = await db
    .update(conversations)
    .set(updates)
    .where(eq(conversations.id, convId))
    .returning();

  res.json({
    group: {
      id: updated.id,
      groupName: updated.groupName,
      groupIconUrl: updated.groupIconUrl,
      inviteSlug: updated.inviteSlug,
    },
  });
});

// ── List Members ────────────────────────────────────────────────────────────
router.get('/:id/members', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const convId = parseInt(req.params.id as string);

  if (isNaN(convId)) {
    res.status(400).json({ error: 'Invalid group ID' });
    return;
  }

  // Must be a member
  const [membership] = await db
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

  if (!membership) {
    res.status(403).json({ error: 'Not a member of this group' });
    return;
  }

  const members = await db
    .select({
      userId: conversationParticipants.userId,
      handle: userProfiles.handle,
      name: users.name,
      avatarUrl: userProfiles.avatarUrl,
      role: conversationParticipants.role,
      joinedAt: conversationParticipants.joinedAt,
    })
    .from(conversationParticipants)
    .innerJoin(users, eq(users.id, conversationParticipants.userId))
    .leftJoin(userProfiles, eq(userProfiles.userId, conversationParticipants.userId))
    .where(
      and(
        eq(conversationParticipants.conversationId, convId),
        isNull(conversationParticipants.leftAt)
      )
    );

  res.json({ members });
});

// ── Kick Member ─────────────────────────────────────────────────────────────
router.delete('/:id/members/:userId', async (req: AuthRequest, res: Response): Promise<void> => {
  const adminId = req.user!.id;
  const convId = parseInt(req.params.id as string);
  const targetUserId = parseInt(req.params.userId as string);

  if (isNaN(convId) || isNaN(targetUserId)) {
    res.status(400).json({ error: 'Invalid ID' });
    return;
  }

  if (adminId === targetUserId) {
    res.status(400).json({ error: 'Cannot kick yourself. Use leave instead.' });
    return;
  }

  // Admin check
  const [adminParticipant] = await db
    .select({ role: conversationParticipants.role })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, convId),
        eq(conversationParticipants.userId, adminId),
        isNull(conversationParticipants.leftAt)
      )
    )
    .limit(1);

  if (!adminParticipant || adminParticipant.role !== 'admin') {
    res.status(403).json({ error: 'Only admins can kick members' });
    return;
  }

  // Target must be a member
  const [target] = await db
    .select({ id: conversationParticipants.id })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, convId),
        eq(conversationParticipants.userId, targetUserId),
        isNull(conversationParticipants.leftAt)
      )
    )
    .limit(1);

  if (!target) {
    res.status(404).json({ error: 'User is not a member of this group' });
    return;
  }

  await db
    .update(conversationParticipants)
    .set({ leftAt: new Date() })
    .where(eq(conversationParticipants.id, target.id));

  res.json({ ok: true });
});

// ── Leave Group ─────────────────────────────────────────────────────────────
router.post('/:id/leave', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const convId = parseInt(req.params.id as string);

  if (isNaN(convId)) {
    res.status(400).json({ error: 'Invalid group ID' });
    return;
  }

  const [membership] = await db
    .select({
      id: conversationParticipants.id,
      role: conversationParticipants.role,
    })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, convId),
        eq(conversationParticipants.userId, userId),
        isNull(conversationParticipants.leftAt)
      )
    )
    .limit(1);

  if (!membership) {
    res.status(403).json({ error: 'Not a member of this group' });
    return;
  }

  // Set leftAt
  await db
    .update(conversationParticipants)
    .set({ leftAt: new Date() })
    .where(eq(conversationParticipants.id, membership.id));

  // If admin, transfer to longest-tenured member
  if (membership.role === 'admin') {
    const [nextAdmin] = await db
      .select({ id: conversationParticipants.id })
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, convId),
          isNull(conversationParticipants.leftAt),
          sql`${conversationParticipants.userId} != ${userId}`
        )
      )
      .orderBy(asc(conversationParticipants.joinedAt))
      .limit(1);

    if (nextAdmin) {
      await db
        .update(conversationParticipants)
        .set({ role: 'admin' })
        .where(eq(conversationParticipants.id, nextAdmin.id));
    }
  }

  res.json({ ok: true });
});

export default router;
