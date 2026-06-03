import { Router, Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { eq, or, ilike } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { users, userProfiles } from '../db/schema';
import logger from '../lib/logger';

const log = logger.child({ module: 'admin' });
const router = Router();

// ── Admin authorization ─────────────────────────────────────────────────────
// Platform-level admin actions (e.g. banning a spammer) are gated by a shared
// secret in the `x-admin-key` header matched against process.env.ADMIN_API_KEY.
// There is no user-level "admin" role in the product, so a server secret is the
// simplest safe gate. If ADMIN_API_KEY is unset the whole router is disabled
// (503) — it can never be accidentally left open.
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) {
    res.status(503).json({ error: 'admin endpoints disabled (ADMIN_API_KEY unset)' });
    return;
  }
  const provided = req.header('x-admin-key') ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Constant-time compare; length guard avoids timingSafeEqual throwing on
  // mismatched buffer lengths (which would itself leak length info).
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

router.use(requireAdmin);

// ── Lookup a user (to find the id before banning) ─────────────────────────────
// GET /api/admin/users/lookup?handle=spammer   OR   ?email=foo@bar.com
// handle match is case-insensitive and ignores a leading '@'.
router.get('/users/lookup', async (req: Request, res: Response): Promise<void> => {
  const handle = (typeof req.query.handle === 'string' ? req.query.handle : '').trim().replace(/^@/, '');
  const email = (typeof req.query.email === 'string' ? req.query.email : '').trim();
  if (!handle && !email) {
    res.status(400).json({ error: 'provide handle or email' });
    return;
  }

  const conditions = [
    handle ? ilike(userProfiles.handle, handle) : undefined,
    email ? ilike(users.email, email) : undefined,
  ].filter(Boolean) as any[];

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      handle: userProfiles.handle,
      bannedAt: users.bannedAt,
      banReason: users.banReason,
      createdAt: users.createdAt,
    })
    .from(users)
    .leftJoin(userProfiles, eq(users.id, userProfiles.userId))
    .where(conditions.length === 1 ? conditions[0] : or(...conditions))
    .limit(25);

  res.json({ users: rows });
});

// ── Ban a user ────────────────────────────────────────────────────────────────
// POST /api/admin/users/ban  { userId, reason? }
// Sets banned_at — does NOT delete the account, so the unique google_id/apple_id
// stays claimed and the user cannot re-register or sign back in. requireAuth and
// the sign-in handlers reject banned users (403 account_suspended).
const banSchema = z.object({
  userId: z.number().int().positive(),
  reason: z.string().max(500).optional(),
});

router.post('/users/ban', async (req: Request, res: Response): Promise<void> => {
  const parse = banSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }
  const { userId, reason } = parse.data;

  const [updated] = await db
    .update(users)
    .set({ bannedAt: new Date(), banReason: reason ?? null, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ id: users.id, email: users.email, bannedAt: users.bannedAt, banReason: users.banReason });

  if (!updated) {
    res.status(404).json({ error: 'user not found' });
    return;
  }
  log.warn({ userId, reason: reason ?? null }, 'user banned');
  res.json({ ok: true, user: updated });
});

// ── Unban a user ───────────────────────────────────────────────────────────────
// POST /api/admin/users/unban  { userId }
const unbanSchema = z.object({ userId: z.number().int().positive() });

router.post('/users/unban', async (req: Request, res: Response): Promise<void> => {
  const parse = unbanSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }
  const { userId } = parse.data;

  const [updated] = await db
    .update(users)
    .set({ bannedAt: null, banReason: null, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ id: users.id, email: users.email, bannedAt: users.bannedAt });

  if (!updated) {
    res.status(404).json({ error: 'user not found' });
    return;
  }
  log.warn({ userId }, 'user unbanned');
  res.json({ ok: true, user: updated });
});

export default router;
