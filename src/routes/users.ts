import { Router, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users, userProfiles } from '../db/schema';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

// ── Get a user's public profile ────────────────────────────────────────────
router.get('/:handle', async (req: AuthRequest, res: Response): Promise<void> => {
  const handle = req.params.handle.toLowerCase();

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
