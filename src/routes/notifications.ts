import { Router, Response } from 'express';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db';
import { notifications } from '../db/schema';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

// ── Get notifications for current user ────────────────────────────────────
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const limit = Math.min(parseInt(req.query.limit as string ?? '30'), 50);

  const userNotifications = await db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);

  const unreadCount = userNotifications.filter((n) => !n.isRead).length;

  res.json({ notifications: userNotifications, unreadCount });
});

// ── Mark notifications as read ─────────────────────────────────────────────
router.put('/read-all', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;

  await db
    .update(notifications)
    .set({ isRead: true })
    .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)));

  res.json({ ok: true });
});

router.put('/:id/read', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const notifId = parseInt(req.params.id);

  await db
    .update(notifications)
    .set({ isRead: true })
    .where(and(eq(notifications.id, notifId), eq(notifications.userId, userId)));

  res.json({ ok: true });
});

export default router;
