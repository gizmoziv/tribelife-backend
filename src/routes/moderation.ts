import { Router, Response } from 'express';
import sgMail from '@sendgrid/mail';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { blockedUsers, contentReports, users, userProfiles } from '../db/schema';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

sgMail.setApiKey(process.env.SENDGRID_API_KEY!);

// ── Block a user ───────────────────────────────────────────────────────────
router.post('/block/:userId', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const blockedUserId = parseInt(req.params.userId as string);

  if (isNaN(blockedUserId) || blockedUserId === userId) {
    res.status(400).json({ error: 'Invalid userId' });
    return;
  }

  try {
    await db
      .insert(blockedUsers)
      .values({ userId, blockedUserId })
      .onConflictDoNothing();

    res.json({ ok: true });
  } catch (err) {
    console.error('[moderation/block]', err);
    res.status(500).json({ error: 'Failed to block user' });
  }
});

// ── Unblock a user ─────────────────────────────────────────────────────────
router.delete('/block/:userId', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const blockedUserId = parseInt(req.params.userId as string);

  if (isNaN(blockedUserId)) {
    res.status(400).json({ error: 'Invalid userId' });
    return;
  }

  try {
    await db
      .delete(blockedUsers)
      .where(
        and(
          eq(blockedUsers.userId, userId),
          eq(blockedUsers.blockedUserId, blockedUserId)
        )
      );

    res.json({ ok: true });
  } catch (err) {
    console.error('[moderation/unblock]', err);
    res.status(500).json({ error: 'Failed to unblock user' });
  }
});

// ── List blocked users ─────────────────────────────────────────────────────
router.get('/blocked', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;

  const rows = await db
    .select({
      id: blockedUsers.id,
      userId: blockedUsers.userId,
      blockedUserId: blockedUsers.blockedUserId,
      createdAt: blockedUsers.createdAt,
    })
    .from(blockedUsers)
    .where(eq(blockedUsers.userId, userId));

  res.json({ blockedUsers: rows });
});

// ── Report content ─────────────────────────────────────────────────────────
const reportSchema = z.object({
  reportedUserId: z.number().int().positive().optional(),
  contentType: z.enum(['message', 'beacon', 'profile']),
  contentId: z.number().int().positive().optional(),
  reason: z.string().min(1).max(2000),
});

router.post('/report', async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = reportSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  const { reportedUserId, contentType, contentId, reason } = parse.data;
  const reporter = req.user!;

  try {
    await db.insert(contentReports).values({
      reporterId: reporter.id,
      reportedUserId: reportedUserId ?? null,
      contentType,
      contentId: contentId ?? null,
      reason,
      status: 'pending',
    });

    // Fetch reported user info for the email if available
    let reportedUserInfo = '';
    if (reportedUserId) {
      const reportedRows = await db
        .select({ name: users.name, email: users.email, handle: userProfiles.handle })
        .from(users)
        .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
        .where(eq(users.id, reportedUserId))
        .limit(1);

      if (reportedRows[0]) {
        reportedUserInfo = `Reported user: ${reportedRows[0].name} (${reportedRows[0].email}) @${reportedRows[0].handle ?? 'N/A'}`;
      }
    }

    await sgMail.send({
      to: 'info@tribelife.app',
      from: process.env.SENDGRID_FROM_EMAIL!,
      subject: `[TribeLife Report] ${contentType} reported`,
      text: [
        `Reporter: ${reporter.name} (${reporter.email}) @${reporter.handle ?? 'N/A'}`,
        reportedUserInfo,
        `Content type: ${contentType}`,
        contentId ? `Content ID: ${contentId}` : '',
        `Reason: ${reason}`,
      ].filter(Boolean).join('\n'),
      html: `
        <p><strong>Reporter:</strong> ${reporter.name} (${reporter.email}) @${reporter.handle ?? 'N/A'}</p>
        ${reportedUserInfo ? `<p><strong>Reported user:</strong> ${reportedUserInfo}</p>` : ''}
        <p><strong>Content type:</strong> ${contentType}</p>
        ${contentId ? `<p><strong>Content ID:</strong> ${contentId}</p>` : ''}
        <p><strong>Reason:</strong> ${reason.replace(/\n/g, '<br />')}</p>
      `,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[moderation/report]', err);
    res.status(500).json({ error: 'Failed to submit report' });
  }
});

export default router;
