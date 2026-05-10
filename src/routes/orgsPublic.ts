import { Router, type Response } from 'express';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  organizations,
  organizationMemberships,
  organizationInvites,
  userProfiles,
  users,
} from '../db/schema';
import { optionalAuth } from '../middleware/optionalAuth';
import type { AuthRequest } from '../middleware/auth';
import logger from '../lib/logger';

const log = logger.child({ module: 'orgsPublic' });
const SLUG_REGEX = /^[a-zA-Z0-9_-]{3,30}$/;
const router = Router();

// ── GET /invites/:token — preview without accepting ───────────────────────────
// Returns { invite: { state, org, inviter, expiresAt } }
// state: 'pending' | 'expired' | 'already_used' | 'already_member'
// IMPORTANT: must be registered BEFORE /:slug wildcard so Express does not
// swallow GET /api/orgs/invites/<token> with slug='invites'.
router.get('/invites/:token', optionalAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const token = req.params.token as string;
  if (!token || token.length < 32) {
    res.status(400).json({ error: 'Invalid invite token' });
    return;
  }

  const [invite] = await db
    .select({
      id: organizationInvites.id,
      orgId: organizationInvites.orgId,
      role: organizationInvites.role,
      expiresAt: organizationInvites.expiresAt,
      acceptedAt: organizationInvites.acceptedAt,
      inviterId: organizationInvites.inviterId,
      org: {
        slug: organizations.slug,
        name: organizations.name,
        type: organizations.type,
        iconUrl: organizations.iconUrl,
        description: organizations.description,
      },
    })
    .from(organizationInvites)
    .innerJoin(organizations, eq(organizations.id, organizationInvites.orgId))
    .where(and(eq(organizationInvites.token, token), isNull(organizations.deletedAt)))
    .limit(1);

  if (!invite) {
    res.status(404).json({ error: 'Invite not found' });
    return;
  }

  // Compute state discriminator: already_used > expired > pending
  let state: 'pending' | 'expired' | 'already_used' = 'pending';
  if (invite.acceptedAt !== null) state = 'already_used';
  else if (invite.expiresAt < new Date()) state = 'expired';

  // Optionally enrich with inviter handle + name
  let inviter: { handle: string | null; name: string } | null = null;
  if (invite.inviterId) {
    const [inv] = await db
      .select({ handle: userProfiles.handle, name: users.name })
      .from(userProfiles)
      .innerJoin(users, eq(users.id, userProfiles.userId))
      .where(eq(userProfiles.userId, invite.inviterId))
      .limit(1);
    if (inv) inviter = inv;
  }

  // Check if requesting user is already a member — override state to 'already_member'
  let alreadyMember = false;
  if (req.user) {
    const [m] = await db
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.orgId, invite.orgId),
          eq(organizationMemberships.userId, req.user.id),
        ),
      )
      .limit(1);
    alreadyMember = !!m;
  }

  log.info({ token: token.slice(0, 8), state, alreadyMember }, '[orgsPublic] invite preview');
  res.json({
    invite: {
      state: alreadyMember ? 'already_member' : state,
      org: invite.org,
      inviter,
      expiresAt: invite.expiresAt.toISOString(),
    },
  });
});

// ── GET /:slug — public org info (works auth + anon) ─────────────────────────
// Returns { org: { id, slug, name, description, type, iconUrl, memberCount, isMember, role } }
// isMember = false and role = null when req.user is undefined (anonymous)
// NOTE: registered AFTER /invites/:token so the wildcard does not shadow it.
router.get('/:slug', optionalAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const slug = req.params.slug as string;
  if (!slug || !SLUG_REGEX.test(slug)) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }

  const [org] = await db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      name: organizations.name,
      description: organizations.description,
      type: organizations.type,
      iconUrl: organizations.iconUrl,
    })
    .from(organizations)
    .where(and(eq(organizations.slug, slug), isNull(organizations.deletedAt)))
    .limit(1);

  if (!org) {
    res.status(404).json({ error: 'Organization not found' });
    return;
  }

  const [{ memberCount }] = await db
    .select({ memberCount: sql<number>`COUNT(*)::int` })
    .from(organizationMemberships)
    .where(eq(organizationMemberships.orgId, org.id));

  // Auth-aware fields
  const userId = req.user?.id;
  let isMember = false;
  let role: 'admin' | 'moderator' | 'member' | null = null;
  if (userId) {
    const [m] = await db
      .select({ role: organizationMemberships.role })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.orgId, org.id),
          eq(organizationMemberships.userId, userId),
        ),
      )
      .limit(1);
    if (m) {
      isMember = true;
      role = m.role;
    }
  }

  log.info({ slug, userId: userId ?? null, isMember }, '[orgsPublic] org page viewed');
  res.json({ org: { ...org, memberCount, isMember, role } });
});

export default router;
