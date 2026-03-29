import { Router, Response } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { userProfiles } from '../db/schema';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { generateAvatarUploadUrl, generateMediaUploadUrls, objectExists, deleteObject, cdnUrlToKey, setPublicRead } from '../services/storage';

const router = Router();

// ── Per-user upload rate limiter (30 uploads/hour — avatar + media) ─────────
const uploadCounts = new Map<number, { count: number; resetAt: number }>();

function checkUploadRateLimit(userId: number): boolean {
  const now = Date.now();
  const entry = uploadCounts.get(userId);

  if (!entry || now > entry.resetAt) {
    uploadCounts.set(userId, { count: 1, resetAt: now + 3_600_000 });
    return true;
  }

  if (entry.count >= 30) {
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

// ── POST /media-urls — Generate pre-signed upload URLs for media ────────────
const mediaUrlsSchema = z.object({
  count: z.number().int().min(1).max(4),
});

router.post('/media-urls', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const parse = mediaUrlsSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.errors[0].message });
      return;
    }

    if (!checkUploadRateLimit(req.user!.id)) {
      res.status(429).json({ error: 'Upload rate limit exceeded. Try again later.' });
      return;
    }

    const uploads = await generateMediaUploadUrls(req.user!.id, parse.data.count);
    res.json({ uploads });
  } catch (err) {
    console.error('[upload] Failed to generate media URLs:', err);
    res.status(500).json({ error: 'Failed to generate upload URLs' });
  }
});

// ── POST /media-confirm — Confirm media uploads and set public-read ACL ────
const mediaConfirmSchema = z.object({
  keys: z.array(z.string().min(1)).min(1).max(4),
});

router.post('/media-confirm', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = mediaConfirmSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  const { keys } = parse.data;
  const prefix = process.env.DO_SPACES_PREFIX || 'prod';

  try {
    // Security: verify every key belongs to this user
    for (const key of keys) {
      if (!key.startsWith(`${prefix}/media/${req.user!.id}/`)) {
        res.status(403).json({ error: 'Key does not belong to this user' });
        return;
      }
    }

    // Verify all objects exist, then set public-read
    for (const key of keys) {
      const exists = await objectExists(key);
      if (!exists) {
        res.status(400).json({ error: `Object not found at key: ${key}` });
        return;
      }
      await setPublicRead(key);
    }

    const cdnUrl = process.env.DO_SPACES_CDN_URL!;
    res.json({ confirmed: true, cdnUrls: keys.map((k) => `${cdnUrl}/${k}`) });
  } catch (err) {
    console.error('[upload] Failed to confirm media:', err);
    res.status(500).json({ error: 'Failed to confirm upload' });
  }
});

export default router;
