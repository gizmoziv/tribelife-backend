import { Router, Response } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { userProfiles } from '../db/schema';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { generateAvatarUploadUrl, objectExists, deleteObject, cdnUrlToKey, setPublicRead } from '../services/storage';

const router = Router();

// ── Per-user upload rate limiter (10 uploads/hour) ──────────────────────────
const uploadCounts = new Map<number, { count: number; resetAt: number }>();

function checkUploadRateLimit(userId: number): boolean {
  const now = Date.now();
  const entry = uploadCounts.get(userId);

  if (!entry || now > entry.resetAt) {
    uploadCounts.set(userId, { count: 1, resetAt: now + 3_600_000 });
    return true;
  }

  if (entry.count >= 10) {
    return false;
  }

  entry.count++;
  return true;
}

// ── POST /avatar-url — Generate pre-signed upload URL ───────────────────────
router.post('/avatar-url', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!checkUploadRateLimit(req.user!.id)) {
      res.status(429).json({ error: 'Upload rate limit exceeded. Try again later.' });
      return;
    }

    const result = await generateAvatarUploadUrl(req.user!.id);
    res.json(result);
  } catch (err) {
    console.error('[upload] Failed to generate avatar URL:', err);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

// ── POST /avatar-confirm — Confirm upload and persist CDN URL ───────────────
const confirmSchema = z.object({
  key: z.string().min(1),
});

router.post('/avatar-confirm', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  console.log('[upload] avatar-confirm called, body:', JSON.stringify(req.body));
  const parse = confirmSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'key is required' });
    return;
  }

  const { key } = parse.data;

  try {
    // Security: verify key belongs to this user
    const prefix = process.env.DO_SPACES_PREFIX || 'prod';
    if (!key.startsWith(`${prefix}/avatars/${req.user!.id}/`)) {
      res.status(403).json({ error: 'Key does not belong to this user' });
      return;
    }

    // Verify object exists in storage
    const exists = await objectExists(key);
    if (!exists) {
      res.status(400).json({ error: 'Object not found at key' });
      return;
    }

    // Make object publicly readable via CDN
    await setPublicRead(key);

    // Delete old avatar if present
    const [profile] = await db
      .select({ avatarUrl: userProfiles.avatarUrl })
      .from(userProfiles)
      .where(eq(userProfiles.userId, req.user!.id));

    if (profile?.avatarUrl) {
      const oldKey = cdnUrlToKey(profile.avatarUrl);
      if (oldKey) {
        await deleteObject(oldKey);
      }
    }

    // Persist new avatar URL
    const cdnUrl = `${process.env.DO_SPACES_CDN_URL}/${key}`;
    await db
      .update(userProfiles)
      .set({ avatarUrl: cdnUrl, updatedAt: new Date() })
      .where(eq(userProfiles.userId, req.user!.id));

    res.json({ avatarUrl: cdnUrl });
  } catch (err) {
    console.error('[upload] Failed to confirm avatar:', err);
    res.status(500).json({ error: 'Failed to confirm upload' });
  }
});

export default router;
