import { Router, Response } from 'express';
import sgMail from '@sendgrid/mail';
import { z } from 'zod';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();

sgMail.setApiKey(process.env.SENDGRID_API_KEY!);

const supportSchema = z.object({
  subject: z.string().min(1).max(200),
  message: z.string().min(1).max(5000),
});

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
      await sgMail.send({
        to: 'info@tribelife.app',
        from: process.env.SENDGRID_FROM_EMAIL!,
        replyTo: user.email,
        subject: `[TribeLife Support] ${subject}`,
        text: `From: ${user.name} (${user.email})\nHandle: @${user.handle}\n\n${message}`,
        html: `
        <p><strong>From:</strong> ${user.name} (${user.email})</p>
        <p><strong>Handle:</strong> @${user.handle}</p>
        <hr />
        <p>${message.replace(/\n/g, '<br />')}</p>
      `,
      });

      res.json({ success: true });
    } catch (err) {
      console.error('[support] Failed to send email:', err);
      res.status(500).json({ error: 'Failed to send support email' });
    }
  },
);

export default router;
