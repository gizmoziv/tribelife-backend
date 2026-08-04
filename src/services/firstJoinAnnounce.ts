import { db } from '../db';
import { messages } from '../db/schema';
import { getZoneForTimezone } from '../config/timezoneZones';
import { getIO } from '../lib/socketRegistry';
import { sendWelcomeEmail } from './email';
import logger from '../lib/logger';

const log = logger.child({ module: 'firstJoinAnnounce' });

// Shared by /onboarding (auth.ts) and the admin access-request approve
// handler (admin.ts) — a user's "first join" signals (welcome email +
// timezone-room "@handle joined the chat" system message) fire from exactly
// one of those two call sites depending on whether the user was gated on
// access review (Phase 34 referral gate): ungated users get it immediately
// at onboarding, gated users get it deferred to admin approval. One
// implementation keeps both call sites from drifting out of sync.
export async function announceFirstJoin(opts: {
  userId: number;
  handle: string;
  timezone: string | null;
  avatarUrl: string | null;
  email: string | null;
  name: string | null;
}): Promise<void> {
  const { userId, handle, timezone, avatarUrl, email, name } = opts;

  // Fire-and-forget — email delivery is not on the critical path, and a
  // SendGrid outage must never block onboarding or an admin's approve call.
  if (email) {
    sendWelcomeEmail({ toEmail: email, name: name ?? '', handle }).catch(
      (err) => log.error({ err: err?.message, userId }, 'welcome email failed'),
    );
  }

  // Persisted with kind='system' so it shows up in scrollback for users who
  // weren't connected at the moment of the join (WhatsApp/Slack pattern).
  // senderId is the new user so the existing leftJoin in chat.ts hydrates
  // handle+avatar, and the literal "@handle" in the body keeps the mention
  // link tappable even if the account is later deleted.
  try {
    const timezoneRoom = `timezone:${getZoneForTimezone(timezone ?? 'UTC')}`;
    const lowerHandle = handle.toLowerCase();
    const announcementContent = `@${lowerHandle} joined the chat`;

    const [systemMsg] = await db
      .insert(messages)
      .values({
        content: announcementContent,
        senderId: userId,
        roomId: timezoneRoom,
        kind: 'system',
        mentions: [userId],
      })
      .returning();

    const io = getIO();
    if (io) {
      io.to(timezoneRoom).emit('room:message', {
        id: systemMsg.id,
        content: announcementContent,
        senderId: userId,
        senderHandle: lowerHandle,
        senderAvatar: avatarUrl ?? null,
        roomId: timezoneRoom,
        createdAt: systemMsg.createdAt,
        kind: 'system',
        mentions: [userId],
        replyToId: null,
        replyTo: null,
      });
    }
  } catch (err) {
    log.error({ err, userId }, 'system join-message broadcast failed');
  }
}
