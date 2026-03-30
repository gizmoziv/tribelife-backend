import { Router, Request, Response } from 'express';
import logger from '../lib/logger';

const log = logger.child({ module: 'android-waitlist' });
import { z } from 'zod';
import sgMail from '@sendgrid/mail';
import { db } from '../db';
import { androidWaitlist } from '../db/schema';

const router = Router();

const schema = z.object({
  email: z.string().email(),
});

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const parse = schema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'Valid email is required' });
    return;
  }

  const { email } = parse.data;

  // 1. Save to DB first — source of truth regardless of email delivery
  try {
    await db.insert(androidWaitlist).values({ email }).onConflictDoNothing();
  } catch (err) {
    log.error({ err }, 'DB error');
    res.status(500).json({ error: 'Failed to join waitlist' });
    return;
  }

  // 2. Send emails — best effort, don't fail the request if email fails
  try {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY!);

    await Promise.allSettled([
      sgMail.send({
        to: process.env.SENDGRID_TO_EMAIL!,
        from: process.env.SENDGRID_FROM_EMAIL!,
        subject: 'New Android Waitlist Signup',
        text: `${email} joined the Android waitlist.`,
      }),
      sgMail.send({
        to: email,
        from: process.env.SENDGRID_FROM_EMAIL!,
        subject: "You're on the TribeLife Android waitlist!",
        text: `Hi!\n\nYou're on the list. We'll notify you as soon as TribeLife launches on Android.\n\nIn the meantime, check us out on iOS: https://apps.apple.com/us/app/tribelife-app/id6759845843\n\nThe TribeLife Team`,
      }),
    ]);
  } catch (err) {
    log.error({ err }, 'Email error (non-fatal)');
  }

  res.json({ ok: true });
});

export default router;
