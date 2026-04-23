import sgMail, { MailDataRequired } from '@sendgrid/mail';
import logger from '../../lib/logger';

const log = logger.child({ module: 'email' });

let initialized = false;

function init(): void {
  if (initialized) return;
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    log.warn('SENDGRID_API_KEY not set — emails will be logged, not sent.');
    return;
  }
  sgMail.setApiKey(apiKey);
  initialized = true;
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  /** SendGrid category for analytics grouping (e.g. 'welcome', 'support'). */
  category?: string;
}

/**
 * Low-level email sender. Every outbound email in the app goes through here.
 *
 * Ordering on SendGrid: `text` is the plaintext fallback for clients that
 * can't render HTML, and is what ends up quoted in replies; `html` is the
 * rich version. Always provide both so Gmail's "show original" view and the
 * reply quote experience stay readable.
 *
 * If `SENDGRID_API_KEY` is unset, sends become no-ops with a log line —
 * developers get instant feedback locally without needing a real API key.
 */
export async function sendEmail(options: SendEmailOptions): Promise<void> {
  init();

  if (!process.env.SENDGRID_API_KEY) {
    log.info(
      { to: options.to, subject: options.subject, category: options.category },
      '[dry-run] email not sent (SENDGRID_API_KEY unset)',
    );
    return;
  }

  const fromEmail = process.env.SENDGRID_FROM_EMAIL;
  if (!fromEmail) {
    const err = new Error('SENDGRID_FROM_EMAIL not set');
    log.error({ err: err.message }, 'cannot send email without a from address');
    throw err;
  }
  const fromName = process.env.SENDGRID_FROM_NAME || 'TribeLife';

  const msg: MailDataRequired = {
    to: options.to,
    from: { email: fromEmail, name: fromName },
    subject: options.subject,
    text: options.text,
    html: options.html,
    replyTo: options.replyTo,
    categories: options.category ? [options.category] : undefined,
  };

  try {
    await sgMail.send(msg);
    log.info(
      { to: options.to, subject: options.subject, category: options.category },
      'email sent',
    );
  } catch (err: any) {
    log.error(
      { err: err?.message, body: err?.response?.body, to: options.to },
      'failed to send email',
    );
    throw err;
  }
}

export { sendWelcomeEmail } from './welcome';
