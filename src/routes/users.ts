import { Router, Response } from 'express';
import { eq, and, inArray, ne, isNull, sql, asc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { users, userProfiles, conversationParticipants } from '../db/schema';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { GLOBE_ROOMS } from '../config/globeRooms';

const router = Router();
router.use(requireAuth);

// ── Get a user's public profile ────────────────────────────────────────────
router.get('/:handle', async (req: AuthRequest, res: Response): Promise<void> => {
  const handle = (req.params.handle as string).toLowerCase();

  const result = await db
    .select({
      id: users.id,
      name: users.name,
      handle: userProfiles.handle,
      avatarUrl: userProfiles.avatarUrl,
      timezone: userProfiles.timezone,
      isPremium: userProfiles.isPremium,
      createdAt: users.createdAt,
    })
    .from(userProfiles)
    .innerJoin(users, eq(users.id, userProfiles.userId))
    .where(eq(userProfiles.handle, handle))
    .limit(1);

  if (result.length === 0) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  res.json({ user: result[0] });
});

// ── Mention autocomplete (scoped by chat context) ────────────────────────
const suggestSchema = z.object({
  q: z.string().max(50).default(''),
  scope: z.enum(['timezone', 'globe', 'group', 'dm']),
  contextId: z.string().min(1).max(100),
});

router.get('/suggest', async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = suggestSchema.safeParse(req.query);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }
  const { q, scope, contextId } = parse.data;
  const userId = req.user!.id;
  const query = q.toLowerCase().trim();

  // Build base where conditions: exclude requester, exclude temp handles, handle prefix match
  const baseWhere = [
    ne(userProfiles.userId, userId),
    sql`${userProfiles.handle} NOT LIKE '\\_temp\\_%' ESCAPE '\\'`,
  ];
  if (query.length > 0) {
    baseWhere.push(sql`LOWER(${userProfiles.handle}) LIKE ${query + '%'}`);
  }

  if (scope === 'timezone') {
    baseWhere.push(eq(userProfiles.timezone, contextId));
  } else if (scope === 'globe') {
    const room = GLOBE_ROOMS.find((r) => r.slug === contextId);
    if (!room || room.timezones.length === 0) {
      res.json({ users: [] });
      return;
    }
    baseWhere.push(inArray(userProfiles.timezone, room.timezones));
  } else if (scope === 'group') {
    const convId = parseInt(contextId, 10);
    if (isNaN(convId)) {
      res.status(400).json({ error: 'Invalid contextId' });
      return;
    }
    // Only active members of the group
    const members = await db
      .select({ userId: conversationParticipants.userId })
      .from(conversationParticipants)
      .where(and(
        eq(conversationParticipants.conversationId, convId),
        isNull(conversationParticipants.leftAt),
      ));
    const memberIds = members.map((m) => m.userId);
    if (memberIds.length === 0) {
      res.json({ users: [] });
      return;
    }
    baseWhere.push(inArray(userProfiles.userId, memberIds));
  } else if (scope === 'dm') {
    // Just the other participant — contextId is their handle
    baseWhere.push(eq(userProfiles.handle, contextId.toLowerCase()));
  }

  const results = await db
    .select({
      userId: userProfiles.userId,
      handle: userProfiles.handle,
      name: users.name,
      avatarUrl: userProfiles.avatarUrl,
    })
    .from(userProfiles)
    .innerJoin(users, eq(users.id, userProfiles.userId))
    .where(and(...baseWhere))
    .orderBy(asc(userProfiles.handle))
    .limit(8);

  res.json({ users: results });
});

// ── Search users by handle (for @mention suggestions) ─────────────────────
router.get('/search/handle', async (req: AuthRequest, res: Response): Promise<void> => {
  const query = (req.query.q as string ?? '').toLowerCase().trim();

  if (query.length < 2) {
    res.json({ users: [] });
    return;
  }

  const results = await db
    .select({
      id: users.id,
      name: users.name,
      handle: userProfiles.handle,
      avatarUrl: userProfiles.avatarUrl,
    })
    .from(userProfiles)
    .innerJoin(users, eq(users.id, userProfiles.userId))
    .limit(10);

  // Filter in JS since Drizzle doesn't support ILIKE simply in v0.44
  const filtered = results.filter(
    (u) => u.handle?.startsWith(query)
  );

  res.json({ users: filtered });
});

export default router;
