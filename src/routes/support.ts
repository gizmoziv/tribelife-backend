import { Router, Request, Response } from 'express';
import logger from '../lib/logger';
import { z } from 'zod';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { sendEmail } from '../services/email';

const log = logger.child({ module: 'support' });

const router = Router();

const supportSchema = z.object({
  subject: z.string().min(1).max(200),
  message: z.string().min(1).max(5000),
});

const publicSupportSchema = z.object({
  subject: z.string().min(1).max(200),
  message: z.string().min(1).max(5000),
  email: z.string().email().max(320),
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

router.post(
  '/',
  requireAuth,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const parse = supportSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: 'Subject and message are required' });
      return;
    }

    const { subject, message } = parse.data;
    const user = req.user!;

    try {
      await sendEmail({
        to: 'info@tribelife.app',
        replyTo: user.email,
        subject: `[TribeLife Support] ${subject}`,
        text: `From: ${user.name} (${user.email})\nHandle: @${user.handle}\n\n${message}`,
        html: `
          <p><strong>From:</strong> ${escapeHtml(user.name ?? '')} (${escapeHtml(user.email)})</p>
          <p><strong>Handle:</strong> @${escapeHtml(user.handle ?? '')}</p>
          <hr />
          <p>${escapeHtml(message).replace(/\n/g, '<br />')}</p>
        `,
        category: 'support',
      });

      res.json({ success: true });
    } catch (err) {
      log.error({ err }, 'Failed to send support email');
      res.status(500).json({ error: 'Failed to send support email' });
    }
  },
);

// Public endpoint (no auth) for the website support form
router.post('/public', async (req: Request, res: Response): Promise<void> => {
  const parse = publicSupportSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'Email, subject, and message are required' });
    return;
  }

  const { subject, message, email } = parse.data;

  try {
    await sendEmail({
      to: 'info@tribelife.app',
      replyTo: email,
      subject: `[TribeLife Support] ${subject}`,
      text: `From: ${email}\n\n${message}`,
      html: `
        <p><strong>From:</strong> ${escapeHtml(email)}</p>
        <hr />
        <p>${escapeHtml(message).replace(/\n/g, '<br />')}</p>
      `,
      category: 'support-public',
    });

    res.json({ success: true });
  } catch (err) {
    log.error({ err }, 'Failed to send support email');
    res.status(500).json({ error: 'Failed to send support email' });
  }
});

export default router;
