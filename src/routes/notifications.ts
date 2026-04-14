import { Router, Response } from 'express';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db';
import { notifications, notificationPreferences } from '../db/schema';
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
  const notifId = parseInt(req.params.id as string, 10);
  if (isNaN(notifId)) { res.status(400).json({ error: 'Invalid ID' }); return; }

  await db
    .update(notifications)
    .set({ isRead: true })
    .where(and(eq(notifications.id, notifId), eq(notifications.userId, userId)));

  res.json({ ok: true });
});

// ── Get notification preferences ───────────────────────────────────────────
router.get('/preferences', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;

  let [prefs] = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId))
    .limit(1);

  if (!prefs) {
    [prefs] = await db
      .insert(notificationPreferences)
      .values({ userId })
      .returning();
  }

  res.json(prefs);
});

// ── Update notification preferences ────────────────────────────────────────
router.put('/preferences', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { mentionsPush, timezoneChatPush, beaconMatchesPush, dmPush } = req.body as {
    mentionsPush?: boolean;
    timezoneChatPush?: boolean;
    beaconMatchesPush?: boolean;
    dmPush?: boolean;
  };

  const updates: Partial<typeof notificationPreferences.$inferInsert> = {};
  if (mentionsPush !== undefined) updates.mentionsPush = mentionsPush;
  if (timezoneChatPush !== undefined) updates.timezoneChatPush = timezoneChatPush;
  if (beaconMatchesPush !== undefined) updates.beaconMatchesPush = beaconMatchesPush;
  if (dmPush !== undefined) updates.dmPush = dmPush;

  const existing = await db
    .select({ id: notificationPreferences.id })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId))
    .limit(1);

  if (existing.length === 0) {
    const [prefs] = await db
      .insert(notificationPreferences)
      .values({ userId, ...updates })
      .returning();
    res.json(prefs);
    return;
  }

  const [prefs] = await db
    .update(notificationPreferences)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(notificationPreferences.userId, userId))
    .returning();

  res.json(prefs);
});

export default router;
