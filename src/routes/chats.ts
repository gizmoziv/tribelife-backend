import { Router, Response } from 'express';
import { z } from 'zod';
import { db } from '../db';
import { globeReadPositions } from '../db/schema';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

// ── Mark a room (Town Square OR Local Chat) as read ────────────────────────
// Phase 9 R-1: timezone room slugs (e.g. 'America/New_York') are NEVER written
// to globe_read_positions by any existing endpoint — the legacy globe-rooms
// mark-read at PUT /api/globe/rooms/:slug/read rejects them via isValidGlobeRoom().
// This endpoint accepts the BARE slug ('town-square' or an IANA timezone string)
// and upserts the per-user (userId, roomSlug) last_read_at row so the Phase 9
// unread aggregate query in /api/chats can compute a meaningful Local Chat
// unreadCount. Auth-gated; the caller may only mark their own rows read
// (req.user.id is the only user_id ever written).
const roomReadSchema = z.object({
  roomSlug: z.string().min(1).max(100),
});

router.post('/room-read', async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = roomReadSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'roomSlug is required' });
    return;
  }

  const userId = req.user!.id;
  const { roomSlug } = parse.data;
  const now = new Date();

  await db
    .insert(globeReadPositions)
    .values({ userId, roomSlug, lastReadAt: now })
    .onConflictDoUpdate({
      target: [globeReadPositions.userId, globeReadPositions.roomSlug],
      set: { lastReadAt: now },
    });

  res.json({ ok: true });
});

export default router;
