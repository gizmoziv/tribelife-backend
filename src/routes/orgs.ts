import { randomBytes } from 'crypto';
import { Router, Response } from 'express';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import {
  organizations,
  organizationMemberships,
  organizationInvites,
  userProfiles,
  users,
  notifications,
} from '../db/schema';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { requireCapability, getCapabilities } from '../middleware/capabilities';
import { sendPushToUser } from '../services/pushNotifications';
import { getIO } from '../lib/socketRegistry';
import logger from '../lib/logger';

const log = logger.child({ module: 'orgs' });
const router = Router();
router.use(requireAuth);

// ── Reserved slugs that cannot be claimed (collide with route segments) ──────
const RESERVED_SLUGS = new Set(['invites', 'me', 'admin', 'new']);
const SLUG_REGEX = /^[a-zA-Z0-9_-]{3,30}$/;
const ORG_TYPES = ['jcc', 'non_profit', 'creator', 'community', 'business'] as const;

const INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── Count admins in an org (used by last-admin guard) ────────────────────────
async function countOrgAdmins(orgId: number): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(organizationMemberships)
    .where(and(
      eq(organizationMemberships.orgId, orgId),
      eq(organizationMemberships.role, 'admin'),
    ));
  return n ?? 0;
}

// ── Create organization ───────────────────────────────────────────────────────
const createOrgSchema = z.object({
  slug: z.string().regex(SLUG_REGEX, 'Slug must be 3-30 chars, [a-zA-Z0-9_-]'),
  name: z.string().min(1).max(80),
  type: z.enum(ORG_TYPES),
  description: z.string().max(500).optional(),
  iconUrl: z.string().url().optional(),
});

router.post(
  '/',
  requireCapability('canCreateOrg', 'Org creation is currently a manual process — contact support'),
  async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = createOrgSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  const slug = parse.data.slug.toLowerCase();
  if (RESERVED_SLUGS.has(slug)) {
    res.status(400).json({ error: 'That slug is reserved' });
    return;
  }

  const userId = req.user!.id;

  // Slug uniqueness pre-check (DB UNIQUE is final guard; this gives a clean error)
  const existing = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.slug, slug), isNull(organizations.deletedAt)))
    .limit(1);
  if (existing.length > 0) {
    res.status(409).json({ error: 'That slug is already taken' });
    return;
  }

  try {
    const created = await db.transaction(async (tx) => {
      const [org] = await tx
        .insert(organizations)
        .values({
          slug,
          name: parse.data.name,
          type: parse.data.type,
          description: parse.data.description,
          iconUrl: parse.data.iconUrl,
          createdBy: userId,
        })
        .returning();

      await tx.insert(organizationMemberships).values({
        orgId: org.id,
        userId,
        role: 'admin',
      });

      return org;
    });

    log.info({ userId, orgId: created.id, slug }, '[orgs] created');
    res.status(201).json({ org: created });
  } catch (err) {
    log.error({ err, userId, slug }, '[orgs] create failed');
    res.status(500).json({ error: 'Failed to create organization' });
  }
  }
);

// ── Edit organization (name / description / iconUrl only — slug + type read-only per D-07) ──
const updateOrgSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  iconUrl: z.string().url().optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  { message: 'At least one field is required' },
);

router.put(
  '/:id',
  async (req: AuthRequest, res: Response): Promise<void> => {
    const orgId = parseInt(req.params.id as string, 10);
    if (isNaN(orgId)) {
      res.status(400).json({ error: 'Invalid org id' });
      return;
    }

    // Admin gate: requireCapability predicate signature is (caps) => boolean (no req arg);
    // org-scoped predicate requires the parsed orgId, so we gate inline here.
    const caps = await getCapabilities(req);
    const isAdmin = caps.orgs.some((o) => o.orgId === orgId && o.role === 'admin');
    if (!isAdmin) {
      res.status(403).json({ error: 'Admin access required', capabilityViolation: true });
      return;
    }

    const parse = updateOrgSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.errors[0].message });
      return;
    }

    try {
      const [updated] = await db
        .update(organizations)
        .set({ ...parse.data, updatedAt: new Date() })
        .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
        .returning();
      if (!updated) {
        res.status(404).json({ error: 'Organization not found' });
        return;
      }
      console.log('[orgs] updated', { userId: req.user!.id, orgId, fields: Object.keys(parse.data) });
      res.json({ org: updated });
    } catch (err) {
      console.error('[orgs] update failed', { err, userId: req.user!.id, orgId });
      res.status(500).json({ error: 'Failed to update organization' });
    }
  },
);

// ── List org members (admin-only) ─────────────────────────────────────────────
router.get(
  '/:id/members',
  async (req: AuthRequest, res: Response): Promise<void> => {
    const orgId = parseInt(req.params.id as string, 10);
    if (isNaN(orgId)) {
      res.status(400).json({ error: 'Invalid org id' });
      return;
    }

    // Admin gate (inline — see PUT /:id note above)
    const caps = await getCapabilities(req);
    const isAdmin = caps.orgs.some((o) => o.orgId === orgId && o.role === 'admin');
    if (!isAdmin) {
      res.status(403).json({ error: 'Admin access required', capabilityViolation: true });
      return;
    }

    try {
      const rows = await db
        .select({
          userId: organizationMemberships.userId,
          role: organizationMemberships.role,
          joinedAt: organizationMemberships.joinedAt,
          handle: userProfiles.handle,
          name: users.name,
          avatarUrl: userProfiles.avatarUrl,
        })
        .from(organizationMemberships)
        .innerJoin(userProfiles, eq(userProfiles.userId, organizationMemberships.userId))
        .innerJoin(users, eq(users.id, organizationMemberships.userId))
        .where(eq(organizationMemberships.orgId, orgId))
        .orderBy(organizationMemberships.joinedAt);

      res.json({ members: rows });
    } catch (err) {
      console.error('[orgs] list members failed', { err, userId: req.user!.id, orgId });
      res.status(500).json({ error: 'Failed to list members' });
    }
  },
);

// ── Change member role (admin-only; admins can promote to admin, moderator, or member) ──
const updateMemberSchema = z.object({
  role: z.enum(['admin', 'moderator', 'member']),
});

router.put(
  '/:id/members/:userId',
  async (req: AuthRequest, res: Response): Promise<void> => {
    const orgId = parseInt(req.params.id as string, 10);
    const subjectId = parseInt(req.params.userId as string, 10);
    if (isNaN(orgId) || isNaN(subjectId)) {
      res.status(400).json({ error: 'Invalid org id or user id' });
      return;
    }

    // Admin gate (inline)
    const caps = await getCapabilities(req);
    const isAdmin = caps.orgs.some((o) => o.orgId === orgId && o.role === 'admin');
    if (!isAdmin) {
      res.status(403).json({ error: 'Admin access required', capabilityViolation: true });
      return;
    }

    const parse = updateMemberSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.errors[0].message });
      return;
    }

    try {
      let current: { role: string } | undefined;
      let updated: typeof organizationMemberships.$inferSelect | undefined;

      await db.transaction(async (tx) => {
        // Lock the memberships table for this transaction to close the
        // TOCTOU window between the last-admin count and the UPDATE (CR-03).
        await tx.execute(sql`LOCK TABLE organization_memberships IN EXCLUSIVE MODE`);

        // Read current membership inside the transaction
        const [row] = await tx
          .select({ role: organizationMemberships.role })
          .from(organizationMemberships)
          .where(and(
            eq(organizationMemberships.orgId, orgId),
            eq(organizationMemberships.userId, subjectId),
          ))
          .limit(1);

        current = row;
        if (!row) return; // handled after transaction

        // Last-admin guard: cannot demote the only admin (D-05)
        if (row.role === 'admin') {
          const [{ n }] = await tx
            .select({ n: sql<number>`COUNT(*)::int` })
            .from(organizationMemberships)
            .where(and(
              eq(organizationMemberships.orgId, orgId),
              eq(organizationMemberships.role, 'admin'),
            ));
          if ((n ?? 0) <= 1) {
            // Signal to outer scope via sentinel value
            current = { role: '__last_admin__' };
            return;
          }
        }

        const [u] = await tx
          .update(organizationMemberships)
          .set({ role: parse.data.role })
          .where(and(
            eq(organizationMemberships.orgId, orgId),
            eq(organizationMemberships.userId, subjectId),
          ))
          .returning();
        updated = u;
      });

      if (!current) {
        res.status(404).json({ error: 'Member not found' });
        return;
      }
      if (current.role === '__last_admin__') {
        res.status(422).json({ error: 'Last admin cannot be demoted' });
        return;
      }

      console.log('[orgs] role-changed', {
        orgId,
        subjectId,
        from: current.role,
        to: parse.data.role,
        by: req.user!.id,
      });
      res.json({ membership: updated });
    } catch (err) {
      console.error('[orgs] role-change failed', { err, userId: req.user!.id, orgId, subjectId });
      res.status(500).json({ error: 'Failed to update member role' });
    }
  },
);

// ── Remove member (admin-only OR self-leave; last-admin guard on both paths) ──
router.delete(
  '/:id/members/:userId',
  async (req: AuthRequest, res: Response): Promise<void> => {
    const orgId = parseInt(req.params.id as string, 10);
    const subjectId = parseInt(req.params.userId as string, 10);
    if (isNaN(orgId) || isNaN(subjectId)) {
      res.status(400).json({ error: 'Invalid org id or user id' });
      return;
    }

    const callerId = req.user!.id;
    const selfLeave = callerId === subjectId;

    // Gate: admin-only OR self-leave (inline — see PUT /:id note)
    const caps = await getCapabilities(req);
    const callerIsAdmin = caps.orgs.some((o) => o.orgId === orgId && o.role === 'admin');
    if (!callerIsAdmin && !selfLeave) {
      res.status(403).json({ error: 'Admin access required (or self-leave)', capabilityViolation: true });
      return;
    }

    try {
      let memberStatus: 'not_found' | 'last_admin' | 'ok' = 'not_found';

      await db.transaction(async (tx) => {
        // Lock the memberships table for this transaction to close the
        // TOCTOU window between the last-admin count and the DELETE (CR-03).
        await tx.execute(sql`LOCK TABLE organization_memberships IN EXCLUSIVE MODE`);

        // Read current membership of the subject inside the transaction
        const [current] = await tx
          .select({ role: organizationMemberships.role })
          .from(organizationMemberships)
          .where(and(
            eq(organizationMemberships.orgId, orgId),
            eq(organizationMemberships.userId, subjectId),
          ))
          .limit(1);

        if (!current) return; // memberStatus stays 'not_found'

        // Last-admin guard: even self-leave is blocked if subject is the only admin (D-05)
        if (current.role === 'admin') {
          const [{ n }] = await tx
            .select({ n: sql<number>`COUNT(*)::int` })
            .from(organizationMemberships)
            .where(and(
              eq(organizationMemberships.orgId, orgId),
              eq(organizationMemberships.role, 'admin'),
            ));
          if ((n ?? 0) <= 1) {
            memberStatus = 'last_admin';
            return;
          }
        }

        await tx
          .delete(organizationMemberships)
          .where(and(
            eq(organizationMemberships.orgId, orgId),
            eq(organizationMemberships.userId, subjectId),
          ));
        memberStatus = 'ok';
      });

      if (memberStatus === 'not_found') {
        res.status(404).json({ error: 'Member not found' });
        return;
      }
      if (memberStatus === 'last_admin') {
        res.status(422).json({ error: 'Last admin cannot be removed' });
        return;
      }

      console.log('[orgs] member-removed', { orgId, subjectId, by: callerId, selfLeave });
      res.json({ ok: true });
    } catch (err) {
      console.error('[orgs] member-remove failed', { err, userId: callerId, orgId, subjectId });
      res.status(500).json({ error: 'Failed to remove member' });
    }
  },
);

// ── Invite member ─────────────────────────────────────────────────────────────
const inviteSchema = z.object({
  invitedHandle: z.string().regex(/^[a-zA-Z0-9_]{3,30}$/).optional(),
  role: z.enum(['admin', 'moderator', 'member']).default('member'),
});

router.post('/:id/invite', async (req: AuthRequest, res: Response): Promise<void> => {
  const orgId = parseInt(req.params.id as string, 10);
  if (isNaN(orgId)) {
    res.status(400).json({ error: 'Invalid org id' });
    return;
  }

  const parse = inviteSchema.safeParse(req.body ?? {});
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  const userId = req.user!.id;

  // Caller must be admin of this org
  const [membership] = await db
    .select({ role: organizationMemberships.role })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.orgId))
    .where(
      and(
        eq(organizationMemberships.orgId, orgId),
        eq(organizationMemberships.userId, userId),
        isNull(organizations.deletedAt),
      ),
    )
    .limit(1);

  if (!membership || membership.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }

  // Resolve invitedUserId from handle (handle-based) or null (link-based)
  let invitedUserId: number | null = null;
  if (parse.data.invitedHandle) {
    const handle = parse.data.invitedHandle.toLowerCase();
    const [target] = await db
      .select({ userId: userProfiles.userId })
      .from(userProfiles)
      .where(eq(userProfiles.handle, handle))
      .limit(1);
    if (!target) {
      res.status(404).json({ error: 'No user with that handle' });
      return;
    }
    invitedUserId = target.userId;
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  try {
    const [invite] = await db
      .insert(organizationInvites)
      .values({
        orgId,
        inviterId: userId,
        invitedUserId,
        token,
        role: parse.data.role,
        expiresAt,
      })
      .returning();

    log.info({ userId, orgId, inviteId: invite.id, invitedUserId }, '[orgs] invite created');

    // ── Path A: handle-search invite — notification row + push + socket (D-06) ──
    // Path B (link generation, invitedUserId === null) emits nothing.
    if (invitedUserId !== null) {
      // Look up org name + slug for the notification body
      const [orgRow] = await db
        .select({ id: organizations.id, slug: organizations.slug, name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);

      // Look up the inviter's handle (caller is req.user — read userProfiles)
      const [inviterProfile] = await db
        .select({ handle: userProfiles.handle })
        .from(userProfiles)
        .where(eq(userProfiles.userId, req.user!.id))
        .limit(1);
      const inviterHandle = inviterProfile?.handle ?? 'someone';

      // 1. Insert in-app notification row
      const [inserted] = await db.insert(notifications).values({
        userId: invitedUserId,
        type: 'org_invite',
        title: orgRow.name,
        body: `${inviterHandle} invited you to join ${orgRow.name}`,
        data: {
          token: invite.token,
          orgSlug: orgRow.slug,
          orgId: orgRow.id,
          inviteId: invite.id,
          inviterHandle,
        },
        isRead: false,
      }).returning();

      // 2. Look up recipient's expo push token
      const [recipient] = await db
        .select({ expoPushToken: userProfiles.expoPushToken })
        .from(userProfiles)
        .where(eq(userProfiles.userId, invitedUserId))
        .limit(1);

      // 3. Send Expo push (graceful no-op when token missing).
      // Bypass shouldSendPush — org invites are critical onboarding and must
      // always deliver regardless of user notification preferences (RESEARCH.md Q13).
      await sendPushToUser(
        recipient?.expoPushToken,
        orgRow.name,
        `${inviterHandle} invited you to join ${orgRow.name}`,
        {
          type: 'org_invite',
          token: invite.token,
          orgSlug: orgRow.slug,
          orgId: orgRow.id,
          inviteId: invite.id,
          notificationId: inserted.id,
        },
        invitedUserId,
      );

      // 4. Real-time bell update for already-foregrounded recipients.
      // Uses the getIO() registry helper (server.ts declares io as a LOCAL const
      // inside bootstrap() — there is NO module-level export from server.ts).
      // getIO() returns null before bootstrap completes; the null-check makes
      // the emit a no-op during cold start (mirrors routes/auth.ts:466 pattern).
      const io = getIO();
      if (io) {
        io.to(`user:${invitedUserId}`).emit('notification:new', {
          id: inserted.id,
          type: 'org_invite',
          title: inserted.title,
          body: inserted.body,
          data: inserted.data,
          isRead: false,
          createdAt: inserted.createdAt,
        });
      }
    }

    res.status(201).json({
      invite: {
        id: invite.id,
        token,
        invitedUserId,
        role: invite.role,
        expiresAt: expiresAt.toISOString(),
      },
    });
  } catch (err) {
    log.error({ err, userId, orgId }, '[orgs] invite failed');
    res.status(500).json({ error: 'Failed to create invite' });
  }
});

// ── Accept invite ─────────────────────────────────────────────────────────────
router.post('/invites/:token/accept', async (req: AuthRequest, res: Response): Promise<void> => {
  const token = req.params.token as string;
  if (!token || token.length < 32) {
    res.status(400).json({ error: 'Invalid invite token' });
    return;
  }

  const userId = req.user!.id;

  const [invite] = await db
    .select({
      id: organizationInvites.id,
      orgId: organizationInvites.orgId,
      role: organizationInvites.role,
      expiresAt: organizationInvites.expiresAt,
      acceptedAt: organizationInvites.acceptedAt,
    })
    .from(organizationInvites)
    .innerJoin(organizations, eq(organizations.id, organizationInvites.orgId))
    .where(and(eq(organizationInvites.token, token), isNull(organizations.deletedAt)))
    .limit(1);

  if (!invite) {
    res.status(404).json({ error: 'Invite not found or org no longer exists' });
    return;
  }
  if (invite.acceptedAt !== null) {
    res.status(410).json({ error: 'Invite already used', code: 'already_used' });
    return;
  }
  if (invite.expiresAt < new Date()) {
    res.status(410).json({ error: 'Invite expired', code: 'expired' });
    return;
  }

  // Already a member? (race-safe — the transaction below also catches via UNIQUE)
  const [existingMembership] = await db
    .select({ id: organizationMemberships.id })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.orgId, invite.orgId),
        eq(organizationMemberships.userId, userId),
      ),
    )
    .limit(1);
  if (existingMembership) {
    res.status(409).json({ error: 'Already a member of this organization' });
    return;
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [m] = await tx
        .insert(organizationMemberships)
        .values({
          orgId: invite.orgId,
          userId,
          role: invite.role,
        })
        .returning();

      await tx
        .update(organizationInvites)
        .set({ acceptedAt: new Date() })
        .where(eq(organizationInvites.id, invite.id));

      return m;
    });

    log.info({ userId, orgId: invite.orgId, inviteId: invite.id, role: invite.role }, '[orgs] invite accepted');
    res.status(201).json({ membership: result });
  } catch (err) {
    // PG unique violation (race): membership exists already
    if ((err as { code?: string })?.code === '23505') {
      res.status(409).json({ error: 'Already a member of this organization' });
      return;
    }
    log.error({ err, userId, orgId: invite.orgId, inviteId: invite.id }, '[orgs] accept failed');
    res.status(500).json({ error: 'Failed to accept invite' });
  }
});

export default router;
