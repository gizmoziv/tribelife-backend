import { randomBytes } from 'crypto';
import { Router, Response } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import {
  organizations,
  organizationMemberships,
  organizationInvites,
  userProfiles,
} from '../db/schema';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { computeCapabilities } from '../services/capabilities';
import { getOrgMembershipsForUser } from '../services/orgMemberships';
import logger from '../lib/logger';

const log = logger.child({ module: 'orgs' });
const router = Router();
router.use(requireAuth);

// ── Reserved slugs that cannot be claimed (collide with route segments) ──────
const RESERVED_SLUGS = new Set(['invites', 'me', 'admin', 'new']);
const SLUG_REGEX = /^[a-zA-Z0-9_-]{3,30}$/;
const ORG_TYPES = ['jcc', 'non_profit', 'creator', 'community', 'business'] as const;

const INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── Create organization ───────────────────────────────────────────────────────
const createOrgSchema = z.object({
  slug: z.string().regex(SLUG_REGEX, 'Slug must be 3-30 chars, [a-zA-Z0-9_-]'),
  name: z.string().min(1).max(80),
  type: z.enum(ORG_TYPES),
  description: z.string().max(500).optional(),
  iconUrl: z.string().url().optional(),
});

router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
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

  // Capability gate (inline — Phase 3 will retrofit middleware)
  const orgMemberships = await getOrgMembershipsForUser(userId);
  const caps = computeCapabilities({
    isPremium: req.user!.isPremium,
    premiumExpiresAt: req.user!.premiumExpiresAt,
    orgMemberships,
  });
  if (!caps.features.canCreateOrg) {
    res.status(403).json({ error: 'Org creation is currently a manual process — contact support', capabilityViolation: true });
    return;
  }

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
});

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
    res.status(410).json({ error: 'Invite already used' });
    return;
  }
  if (invite.expiresAt < new Date()) {
    res.status(410).json({ error: 'Invite expired' });
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
