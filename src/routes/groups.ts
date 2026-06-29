import { Router, Response } from 'express';
import { Server } from 'socket.io';
import { eq, and, sql, isNull, asc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import {
  conversations,
  conversationParticipants,
  users,
  userProfiles,
  messages,
} from '../db/schema';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { requireCapability, CapabilityViolationError } from '../middleware/capabilities';
import { computeCapabilities } from '../services/capabilities';
import { enforceLimit, countOwnedGroups } from '../services/limitChecks';
import { getOrgMembershipsForUser } from '../services/orgMemberships';
import { logCapabilityDenial } from '../lib/capabilityLogger';
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

// ── List my groups (admin/member) ───────────────────────────────────────────
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const roleFilter = typeof req.query.role === 'string' ? req.query.role : undefined;

  const rows = await db
    .select({
      id: conversations.id,
      groupName: conversations.groupName,
      groupIconUrl: conversations.groupIconUrl,
      inviteSlug: conversations.inviteSlug,
      createdAt: conversations.createdAt,
      role: conversationParticipants.role,
      // Use explicit `conversations.id` instead of `${conversations.id}` —
      // Drizzle interpolates the column ref as bare `"id"`, which PG resolves
      // against the inner cp2 scope (cp2.id) and silently miscounts. Same
      // bug pattern fixed in routes/globe.ts publicGroupsRaw.
      memberCount: sql<number>`(
        select count(*)::int from conversation_participants cp2
        where cp2.conversation_id = conversations.id and cp2.left_at is null
      )`,
    })
    .from(conversationParticipants)
    .innerJoin(conversations, eq(conversations.id, conversationParticipants.conversationId))
    .where(
      and(
        eq(conversationParticipants.userId, userId),
        eq(conversations.isGroup, true),
        isNull(conversationParticipants.leftAt),
        ...(roleFilter === 'admin' ? [eq(conversationParticipants.role, 'admin')] : []),
      )
    )
    .orderBy(asc(conversations.createdAt));

  res.json({ groups: rows });
});

// ── Create Group ────────────────────────────────────────────────────────────
const createGroupSchema = z.object({
  name: z.string().min(1).max(50),
  slug: z.string().min(1).max(50).optional(),
  isPublic: z.boolean().default(false),
});

router.post(
  '/',
  (req: AuthRequest, res: Response, next) => {
    const isPublic = req.body?.isPublic === true;
    return requireCapability(
      (caps) => isPublic ? caps.features.canCreatePublicGroup : caps.features.canCreatePrivateGroup,
      'You need Premium to create a private group',
    )(req, res, next);
  },
  async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;

  const parse = createGroupSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'Invalid input', details: parse.error.flatten() });
    return;
  }

  // CARRY-01: enforce maxGroupsOwned limit AFTER the Phase 12 D-02 capability
  // predicate (tier-availability gate runs as middleware before this body) and
  // BEFORE the slug uniqueness check + DB insert. `logCapabilityDenial` is
  // emitted internally by enforceLimit on the over-limit path.
  try {
    await enforceLimit(req, 'maxGroupsOwned', countOwnedGroups);
  } catch (err) {
    if (err instanceof CapabilityViolationError) {
      const max = err.max ?? 0;
      res.status(403).json({
        error: max > 1
          ? `You can own up to ${max} groups`
          : `Free accounts can own 1 group. Upgrade to Premium for more.`,
        capabilityViolation: true,
      });
      return;
    }
    throw err;
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
    let convo: typeof conversations.$inferSelect | undefined;
    let attempts = 0;
    while (attempts < 3) {
      try {
        const [row] = await db
          .insert(conversations)
          .values({
            isGroup: true,
            groupName: name,
            inviteSlug: slug,
            createdById: userId,
            isPublic: parse.data.isPublic,
          })
          .returning();
        convo = row;
        break;
      } catch (err: any) {
        if (err?.cause?.code === '23505' && err?.cause?.constraint?.includes('invite_slug')) {
          slug = generateSlug(name);
          attempts++;
          continue;
        }
        throw err;
      }
    }

    if (!convo) {
      res.status(500).json({ error: 'Failed to create group — slug collision' });
      return;
    }

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
  }
);

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
      isPublic: conversations.isPublic,
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

  // Surface the earliest-joined active admin so non-members can see who runs
  // the group and tap through to DM them. Single admin is sufficient for the
  // UI affordance even when the group has multiple admins.
  const [admin] = await db
    .select({
      id: conversationParticipants.userId,
      handle: userProfiles.handle,
      name: users.name,
      avatarUrl: userProfiles.avatarUrl,
    })
    .from(conversationParticipants)
    .innerJoin(users, eq(users.id, conversationParticipants.userId))
    .leftJoin(userProfiles, eq(userProfiles.userId, conversationParticipants.userId))
    .where(
      and(
        eq(conversationParticipants.conversationId, group.id),
        eq(conversationParticipants.role, 'admin'),
        isNull(conversationParticipants.leftAt)
      )
    )
    .orderBy(asc(conversationParticipants.joinedAt))
    .limit(1);

  res.json({
    group: {
      id: group.id,
      groupName: group.groupName,
      groupIconUrl: group.groupIconUrl,
      inviteSlug: group.inviteSlug,
      isPublic: group.isPublic,
      memberCount: countResult?.count ?? 0,
      createdAt: group.createdAt,
      isMember,
      admin: admin
        ? {
            id: admin.id,
            handle: admin.handle ?? '',
            name: admin.name ?? '',
            avatarUrl: admin.avatarUrl ?? null,
          }
        : null,
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
      createdById: conversations.createdById,
      archivedAt: conversations.archivedAt,
    })
    .from(conversations)
    .where(and(eq(conversations.inviteSlug, slug), eq(conversations.isGroup, true)))
    .limit(1);

  if (!group) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }

  // D-12: reject join on archived group
  if (group.archivedAt) {
    res.status(403).json({ error: 'Group archived' });
    return;
  }

  // Check if already a member
  const [existing] = await db
    .select({
      id: conversationParticipants.id,
      leftAt: conversationParticipants.leftAt,
      role: conversationParticipants.role,
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

  if (existing && existing.role === 'kicked') {
    res.status(403).json({ error: 'You were removed from this group' });
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

  // TIER-06: enforce maxGroupMembers against the OWNER's capabilities
  // (Phase 4 F-1). Mirror the enforceLimit pattern but compute caps for
  // group.createdById since the joiner's caps are irrelevant.
  const [ownerProfile] = await db
    .select({
      isPremium: userProfiles.isPremium,
      premiumExpiresAt: userProfiles.premiumExpiresAt,
    })
    .from(userProfiles)
    .where(eq(userProfiles.userId, group.createdById!))
    .limit(1);

  const ownerMemberships = await getOrgMembershipsForUser(group.createdById!);
  const ownerCaps = computeCapabilities({
    isPremium: ownerProfile!.isPremium,
    premiumExpiresAt: ownerProfile!.premiumExpiresAt,
    orgMemberships: ownerMemberships,
  });
  const memberCap = ownerCaps.limits.maxGroupMembers;

  if (countResult.count >= memberCap) {
    logCapabilityDenial({
      req,
      capability: 'maxGroupMembers',
      currentTier: ownerCaps.tier,
      reason: 'limit',
      current: countResult.count,
      max: memberCap,
    });
    res.status(403).json({
      error: `Group is full — owner's tier allows up to ${memberCap} members`,
      capabilityViolation: true,
    });
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

  // Phase 12: post a system message announcing the join so existing members
  // and current previewers see who just joined. Mirrors the timezone-room
  // pattern in routes/auth.ts:454-490.
  try {
    const joinerHandle = (req.user!.handle ?? '').toLowerCase();
    if (joinerHandle) {
      const announcementContent = `@${joinerHandle} joined the community`;
      const [systemMsg] = await db
        .insert(messages)
        .values({
          content: announcementContent,
          senderId: userId,
          conversationId: group.id,
          kind: 'system',
          mentions: [userId],
        })
        .returning();

      // Bump lastMessageAt so the new row order is correct on next Chevra fetch.
      await db
        .update(conversations)
        .set({ lastMessageAt: new Date() })
        .where(eq(conversations.id, group.id));

      const io = req.app.get('io') as Server | undefined;
      if (io) {
        io.to(`conversation:${group.id}`).emit('dm:message', {
          id: systemMsg.id,
          content: announcementContent,
          senderId: userId,
          senderHandle: joinerHandle,
          senderAvatar: req.user!.avatarUrl ?? null,
          conversationId: group.id,
          createdAt: systemMsg.createdAt,
          kind: 'system',
          mentions: [userId],
          replyToId: null,
          replyTo: null,
        });
        // Live-update Chevra rows so observers see the latest preview.
        io.emit('chevra:group-message', {
          conversationId: group.id,
          name: group.groupName ?? 'Group',
          iconUrl: null,
          lastMessage: {
            content: announcementContent,
            createdAt: systemMsg.createdAt,
            senderHandle: joinerHandle,
          },
        });
      }
    }
  } catch (err) {
    log.error({ err, userId, groupId: group.id }, '[groups] join announcement failed');
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
  isPublic: z.boolean().optional(),
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

  // Capture the current name so we can detect a real rename (and reference the
  // old → new transition) for the system announcement below.
  const [currentConv] = await db
    .select({ groupName: conversations.groupName })
    .from(conversations)
    .where(eq(conversations.id, convId))
    .limit(1);
  const previousName = currentConv?.groupName ?? null;

  const updates: Partial<typeof conversations.$inferInsert> = {};
  if (parse.data.name) updates.groupName = parse.data.name;
  if (parse.data.groupIconUrl !== undefined) updates.groupIconUrl = parse.data.groupIconUrl;
  if (parse.data.isPublic !== undefined) updates.isPublic = parse.data.isPublic;

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

  // Announce a real rename as an in-thread system message so members see who
  // changed the name and to what. Mirrors the join-announcement pattern above.
  if (parse.data.name && updated.groupName && updated.groupName !== previousName) {
    try {
      const actorHandle = (req.user!.handle ?? '').toLowerCase();
      const announcementContent = `@${actorHandle} renamed the group to "${updated.groupName}"`;
      const [systemMsg] = await db
        .insert(messages)
        .values({
          content: announcementContent,
          senderId: userId,
          conversationId: convId,
          kind: 'system',
          mentions: [userId],
        })
        .returning();

      // Bump lastMessageAt so the new row order is correct on next Chevra fetch.
      await db
        .update(conversations)
        .set({ lastMessageAt: new Date() })
        .where(eq(conversations.id, convId));

      const io = req.app.get('io') as Server | undefined;
      if (io) {
        io.to(`conversation:${convId}`).emit('dm:message', {
          id: systemMsg.id,
          content: announcementContent,
          senderId: userId,
          senderHandle: actorHandle,
          senderAvatar: req.user!.avatarUrl ?? null,
          conversationId: convId,
          createdAt: systemMsg.createdAt,
          kind: 'system',
          mentions: [userId],
          replyToId: null,
          replyTo: null,
        });
        // Live-update Chevra rows so observers see the latest preview + new name.
        io.emit('chevra:group-message', {
          conversationId: convId,
          name: updated.groupName,
          iconUrl: updated.groupIconUrl ?? null,
          lastMessage: {
            content: announcementContent,
            createdAt: systemMsg.createdAt,
            senderHandle: actorHandle,
          },
        });
      }
    } catch (err) {
      log.error({ err, userId, groupId: convId }, '[groups] rename announcement failed');
    }
  }

  res.json({
    group: {
      id: updated.id,
      groupName: updated.groupName,
      groupIconUrl: updated.groupIconUrl,
      inviteSlug: updated.inviteSlug,
      isPublic: updated.isPublic,
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
      lastDeliveredAt: conversationParticipants.lastDeliveredAt, // D-01a: cold-open receipt hydration
      lastReadAt: conversationParticipants.lastReadAt, // D-01a: cold-open receipt hydration
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
    .set({ leftAt: new Date(), role: 'kicked' })
    .where(eq(conversationParticipants.id, target.id));

  // Phase 12: tell the kicked user's connected clients so the group disappears
  // from their Chats list and any open chat screen ejects to the list.
  try {
    const io = req.app.get('io') as Server | undefined;
    if (io) {
      io.to(`user:${targetUserId}`).emit('chat:removed', {
        conversationId: convId,
        reason: 'kicked' as const,
      });
    }
  } catch (err) {
    log.error({ err, convId, targetUserId }, '[groups] chat:removed emit failed');
  }

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
    .select({ id: conversationParticipants.id, role: conversationParticipants.role })
    .from(conversationParticipants)
    .where(and(
      eq(conversationParticipants.conversationId, convId),
      eq(conversationParticipants.userId, userId),
      isNull(conversationParticipants.leftAt),
    ))
    .limit(1);

  if (!membership) {
    res.status(403).json({ error: 'Not a member of this group' });
    return;
  }

  // D-05: detect last-admin BEFORE mutating leftAt
  let isLastAdmin = false;
  if (membership.role === 'admin') {
    const [{ count: remainingAdmins }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(conversationParticipants)
      .where(and(
        eq(conversationParticipants.conversationId, convId),
        eq(conversationParticipants.role, 'admin'),
        isNull(conversationParticipants.leftAt),
        sql`${conversationParticipants.userId} != ${userId}`,
      ));
    isLastAdmin = remainingAdmins === 0;
  }

  // D-05: atomic leave + optional archive in a single transaction
  await db.transaction(async (tx) => {
    await tx.update(conversationParticipants)
      .set({ leftAt: new Date() })
      .where(eq(conversationParticipants.id, membership.id));

    if (isLastAdmin) {
      await tx.update(conversations)
        .set({ archivedAt: new Date() })
        .where(eq(conversations.id, convId));
    }
  });

  if (isLastAdmin) {
    log.info({ conversationId: convId, archivedBy: userId }, '[groups] archived');
  }

  res.json({ ok: true, archived: isLastAdmin });
});

export default router;
