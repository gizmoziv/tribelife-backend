import { Router, Response } from 'express';
import logger from '../lib/logger';

const log = logger.child({ module: 'upload' });
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { userProfiles, conversations, conversationParticipants } from '../db/schema';
import { and, isNull } from 'drizzle-orm';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { generateAvatarUploadUrl, generateGroupIconUploadUrl, generateMediaUploadUrls, objectExists, deleteObject, cdnUrlToKey, setPublicRead } from '../services/storage';

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
    log.error({ err }, 'Failed to generate avatar URL');
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

// ── POST /avatar-confirm — Confirm upload and persist CDN URL ───────────────
const confirmSchema = z.object({
  key: z.string().min(1),
});

router.post('/avatar-confirm', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  log.info({ body: req.body }, 'avatar-confirm called');
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
    log.error({ err }, 'Failed to confirm avatar');
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
    log.error({ err }, 'Failed to generate media URLs');
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
    log.error({ err }, 'Failed to confirm media');
    res.status(500).json({ error: 'Failed to confirm upload' });
  }
});

// ── POST /group-icon-url — Pre-signed URL for group icon (admin only) ──────
const groupIconUrlSchema = z.object({
  conversationId: z.number().int().positive(),
});

async function assertGroupAdmin(userId: number, conversationId: number): Promise<boolean> {
  const [participant] = await db
    .select({ role: conversationParticipants.role })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.userId, userId),
        isNull(conversationParticipants.leftAt)
      )
    )
    .limit(1);
  return participant?.role === 'admin';
}

router.post('/group-icon-url', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const parse = groupIconUrlSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: 'conversationId is required' });
      return;
    }

    if (!checkUploadRateLimit(req.user!.id)) {
      res.status(429).json({ error: 'Upload rate limit exceeded. Try again later.' });
      return;
    }

    const isAdmin = await assertGroupAdmin(req.user!.id, parse.data.conversationId);
    if (!isAdmin) {
      res.status(403).json({ error: 'Only group admins can upload a group icon' });
      return;
    }

    const result = await generateGroupIconUploadUrl(parse.data.conversationId);
    res.json(result);
  } catch (err) {
    log.error({ err }, 'Failed to generate group icon URL');
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

// ── POST /group-icon-confirm — Confirm upload and persist CDN URL ─────────
const groupIconConfirmSchema = z.object({
  conversationId: z.number().int().positive(),
  key: z.string().min(1),
});

router.post('/group-icon-confirm', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = groupIconConfirmSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'conversationId and key are required' });
    return;
  }

  const { conversationId, key } = parse.data;

  try {
    const isAdmin = await assertGroupAdmin(req.user!.id, conversationId);
    if (!isAdmin) {
      res.status(403).json({ error: 'Only group admins can update the group icon' });
      return;
    }

    // Verify key belongs to this conversation
    const prefix = process.env.DO_SPACES_PREFIX || 'prod';
    if (!key.startsWith(`${prefix}/groups/${conversationId}/`)) {
      res.status(403).json({ error: 'Key does not belong to this group' });
      return;
    }

    const exists = await objectExists(key);
    if (!exists) {
      res.status(400).json({ error: 'Object not found at key' });
      return;
    }

    await setPublicRead(key);

    // Delete previous icon if present
    const [convo] = await db
      .select({ groupIconUrl: conversations.groupIconUrl })
      .from(conversations)
      .where(eq(conversations.id, conversationId));

    if (convo?.groupIconUrl) {
      const oldKey = cdnUrlToKey(convo.groupIconUrl);
      if (oldKey) await deleteObject(oldKey);
    }

    const cdnUrl = `${process.env.DO_SPACES_CDN_URL}/${key}`;
    await db
      .update(conversations)
      .set({ groupIconUrl: cdnUrl })
      .where(eq(conversations.id, conversationId));

    res.json({ groupIconUrl: cdnUrl });
  } catch (err) {
    log.error({ err }, 'Failed to confirm group icon');
    res.status(500).json({ error: 'Failed to confirm upload' });
  }
});

export default router;
