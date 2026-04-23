import { sendEmail } from './index';

interface WelcomeEmailContext {
  name: string;
  handle: string;
  appUrl?: string;
}

interface Feature {
  emoji: string;
  title: string;
  body: string;
}

const FEATURES: Feature[] = [
  {
    emoji: '🔥',
    title: 'Beacons — say what you need',
    body: 'Post a short request — a Shabbat host, a learning partner, a minyan, a moving helper. Every day at 6am UTC our matching engine connects you with real people nearby. One beacon free, three with Premium.',
  },
  {
    emoji: '🌍',
    title: 'Globe Rooms — Jews, worldwide, right now',
    body: "Jump into regional chat rooms: North America, Israel, Europe, UK & Ireland, Latin America, Australia/NZ, South Africa. See who is talking in your region — or step into someone else's.",
  },
  {
    emoji: '💬',
    title: 'Local Chat — your timezone is your neighborhood',
    body: 'Talk with Jews who are actually awake when you are. No more 3am replies. Your local room is already waiting.',
  },
  {
    emoji: '✉️',
    title: 'Direct Messages & Groups',
    body: 'When a conversation clicks — or you match with someone — take it private. One-on-one DMs plus private groups for your shul, chevra, or study circle (Premium).',
  },
  {
    emoji: '📰',
    title: 'Jewish News',
    body: 'A curated Jewish news feed from trusted sources. Stay informed without the noise — all in one place.',
  },
  {
    emoji: '⭐',
    title: 'Premium — for the ones who show up',
    body: 'Three active beacons, private groups creation, priority matching. $4.99/month — and every subscription keeps TribeLife independent.',
  },
];

function buildWelcomeEmail({
  name,
  handle,
  appUrl = 'https://tribelife.app',
}: WelcomeEmailContext) {
  const firstName = (name?.split(' ')[0] || 'Friend').trim();
  const safeHandle = handle.replace(/[^a-zA-Z0-9_]/g, '');
  const subject = `Welcome to TribeLife, @${safeHandle} — our people are already here`;

  const featureRowsHtml = FEATURES.map(
    (f) => `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 18px 0;">
        <tr>
          <td width="60" valign="top" style="padding-right: 14px;">
            <div style="width: 48px; height: 48px; background: linear-gradient(135deg, rgba(147,51,234,0.14), rgba(245,158,11,0.14)); border-radius: 12px; text-align: center; line-height: 48px; font-size: 24px;">${f.emoji}</div>
          </td>
          <td valign="top">
            <div style="font-size: 16px; font-weight: 700; color: #111827; margin-bottom: 4px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">${f.title}</div>
            <div style="font-size: 14px; line-height: 1.55; color: #4b5563; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">${f.body}</div>
          </td>
        </tr>
      </table>`,
  ).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light only">
  <title>Welcome to TribeLife</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f6f5ff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1f2937;">
  <div style="display:none; max-height:0; overflow:hidden; opacity:0; visibility:hidden; mso-hide:all;">Our people are already here. Post a beacon, drop into a Globe room, or just say hi.</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #f6f5ff; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(17, 24, 39, 0.06);">
          <tr>
            <td style="background-image: linear-gradient(135deg, #9333EA 0%, #E879A0 55%, #F59E0B 100%); background-color: #9333EA; padding: 44px 32px; text-align: center;">
              <div style="font-size: 32px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">TribeLife</div>
              <div style="font-size: 14px; color: rgba(255,255,255,0.92); margin-top: 6px; font-weight: 500; letter-spacing: 0.3px;">Our community, supercharged.</div>
            </td>
          </tr>
          <tr>
            <td style="padding: 40px 32px 8px 32px;">
              <h1 style="margin: 0 0 12px 0; font-size: 26px; font-weight: 800; color: #111827; letter-spacing: -0.3px;">Welcome, @${safeHandle} 👋</h1>
              <p style="margin: 0; font-size: 16px; line-height: 1.6; color: #4b5563;">
                Shalom ${firstName}! You just joined a growing circle of Jews and allies across the world who believe in showing up for each other. Whether you are looking for a Shabbat host, a study partner, a minyan, or just our people — TribeLife was built for this.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 32px 32px 0 32px;">
              <h2 style="margin: 0 0 20px 0; font-size: 18px; font-weight: 700; color: #111827;">Here's what you can do right now</h2>
              ${featureRowsHtml}
            </td>
          </tr>
          <tr>
            <td style="padding: 16px 32px 8px 32px; text-align: center;">
              <a href="${appUrl}" style="display: inline-block; background-image: linear-gradient(135deg, #9333EA 0%, #F97316 100%); background-color: #9333EA; color: #ffffff; text-decoration: none; padding: 16px 40px; border-radius: 999px; font-size: 16px; font-weight: 700; letter-spacing: 0.2px; box-shadow: 0 6px 18px rgba(147, 51, 234, 0.35);">Open TribeLife</a>
              <p style="margin: 18px 0 0 0; font-size: 13px; color: #6b7280;">The matcher runs every day at 6am UTC. Post a beacon tonight — you could have a match by morning.</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 28px 32px 16px 32px;">
              <div style="padding: 20px 22px; background-color: #fff7ed; border-left: 4px solid #F59E0B; border-radius: 10px;">
                <div style="font-size: 12px; font-weight: 700; color: #B45309; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 8px;">A note from the team</div>
                <div style="font-size: 14px; line-height: 1.6; color: #4b5563; font-style: italic;">
                  TribeLife is not another feed, not another inbox. It is a place to be present for our people. Try the Globe to see who is talking right now, or post your first beacon — and see what happens.
                </div>
              </div>
            </td>
          </tr>
          <tr>
            <td style="background-color: #f9fafb; padding: 24px 32px; text-align: center; border-top: 1px solid #e5e7eb;">
              <p style="margin: 0 0 8px 0; font-size: 12px; color: #9ca3af;">You received this because you just joined TribeLife as <strong>@${safeHandle}</strong>.</p>
              <p style="margin: 0; font-size: 12px; color: #9ca3af;">
                <a href="https://tribelife.app/support" style="color: #9333EA; text-decoration: none;">Support</a>
                &nbsp;·&nbsp;
                <a href="https://tribelife.app/privacy" style="color: #9333EA; text-decoration: none;">Privacy</a>
                &nbsp;·&nbsp;
                <a href="https://tribelife.app/terms" style="color: #9333EA; text-decoration: none;">Terms</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const featureTextBlocks = FEATURES.map(
    (f) => `${f.emoji}  ${f.title.toUpperCase()}\n${f.body}`,
  ).join('\n\n');

  const text = `Welcome to TribeLife, @${safeHandle}

Shalom ${firstName}! You just joined a growing circle of Jews and allies across the world who believe in showing up for each other. Whether you are looking for a Shabbat host, a study partner, a minyan, or just our people — TribeLife was built for this.

Here's what you can do right now:

${featureTextBlocks}

Open TribeLife: ${appUrl}

The matcher runs every day at 6am UTC. Post a beacon tonight — you could have a match by morning.

—
A note from the team:
TribeLife is not another feed, not another inbox. It is a place to be present for our people. Try the Globe to see who is talking right now, or post your first beacon — and see what happens.

—
You received this because you just joined TribeLife as @${safeHandle}.
Support:  https://tribelife.app/support
Privacy:  https://tribelife.app/privacy
Terms:    https://tribelife.app/terms`;

  return { subject, html, text };
}

export async function sendWelcomeEmail(opts: {
  toEmail: string;
  name: string;
  handle: string;
}): Promise<void> {
  const { subject, html, text } = buildWelcomeEmail({
    name: opts.name,
    handle: opts.handle,
  });
  await sendEmail({
    to: opts.toEmail,
    subject,
    html,
    text,
    category: 'welcome',
  });
}
