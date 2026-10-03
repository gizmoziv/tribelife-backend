// Link-click analytics routes (quick 261003-nfu).
//
// Mounted INSIDE the chat router after requireAuth + requireApprovedAccess
// (never in server.ts), so auth runs once. The write path records taps for
// every sender (D1); the read path is added for premium senders only.
//
//   POST /api/chat/messages/:id/link-clicks   → { ok: true }
//
// Fail-soft: until migration 0046 is applied the POST answers { ok: true } and
// logs one warning. Only a missing message_link_clicks relation is swallowed;
// any other error is a logged 500.

import { Router, Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  messages,
  conversations,
  conversationParticipants,
  messageLinkClicks,
} from '../db/schema';
import type { AuthRequest } from '../middleware/auth';
import logger from '../lib/logger';
import { linkKey, messageLinkKeys } from '../utils/messageLinks';
import {
  LINK_CLICK_SOURCES,
  LINK_CLICK_PLATFORMS,
  isLinkAnalyticsConversation,
  decideLinkClickWrite,
  linkClickDedupeCutoff,
  isMissingRelationError,
} from '../utils/linkClickStats';

const log = logger.child({ module: 'link-clicks' });

const router = Router();

// 60 taps/min per user, keyed on the user id (same shape as chat's searchLimiter).
const linkClickLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => String((req as AuthRequest).user?.id ?? req.ip),
  handler: (_req, res) => res.status(429).json({ error: 'too many link clicks' }),
});

const linkClickSchema = z.object({
  url: z.string().trim().min(1, 'url is required').max(4096, 'url is too long'),
  source: z.enum(LINK_CLICK_SOURCES),
  platform: z.enum(LINK_CLICK_PLATFORMS),
});

// Warn about the missing table once per process, not once per tap.
let warnedMissingTable = false;

// ── Record a tap on a link in a group message ───────────────────────────────
router.post('/messages/:id/link-clicks', linkClickLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const messageId = parseInt(req.params.id as string);
  try {
    const userId = req.user!.id;
    if (isNaN(messageId) || messageId <= 0) {
      res.status(400).json({ error: 'Invalid message ID' });
      return;
    }

    const parse = linkClickSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.errors[0].message });
      return;
    }

    const key = linkKey(parse.data.url);
    if (key === null) {
      res.status(400).json({ error: 'Invalid link' });
      return;
    }

    const [msg] = await db
      .select({
        id: messages.id,
        content: messages.content,
        senderId: messages.senderId,
        conversationId: messages.conversationId,
        deletedAt: messages.deletedAt,
        kind: messages.kind,
      })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);
    if (!msg || msg.deletedAt != null || msg.conversationId == null || msg.kind === 'system') {
      res.status(404).json({ error: 'Message not found' });
      return;
    }
    const conversationId = msg.conversationId;

    // DF-1: the sender's own click is a no-op, with no further queries.
    if (msg.senderId === userId) {
      res.json({ ok: true });
      return;
    }

    const [conversation] = await db
      .select({ isGroup: conversations.isGroup })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!isLinkAnalyticsConversation(conversation)) {
      res.status(422).json({ error: 'Link clicks are only tracked in groups' });
      return;
    }

    const [participant] = await db
      .select({ id: conversationParticipants.id })
      .from(conversationParticipants)
      .where(and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.userId, userId),
        isNull(conversationParticipants.leftAt),
      ))
      .limit(1);
    if (!participant) {
      res.status(403).json({ error: 'Not a participant in this conversation' });
      return;
    }

    // Reject spoofed urls: the key must be one of the message's own links.
    if (!messageLinkKeys(msg.content).includes(key)) {
      res.status(404).json({ error: 'Link not found in message' });
      return;
    }

    const now = new Date();
    const [[countRow], recent] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(messageLinkClicks)
        .where(and(
          eq(messageLinkClicks.messageId, msg.id),
          eq(messageLinkClicks.userId, userId),
        )),
      db
        .select({ id: messageLinkClicks.id })
        .from(messageLinkClicks)
        .where(and(
          eq(messageLinkClicks.messageId, msg.id),
          eq(messageLinkClicks.userId, userId),
          eq(messageLinkClicks.url, key),
          gt(messageLinkClicks.clickedAt, linkClickDedupeCutoff(now)),
        ))
        .limit(1),
    ]);

    const decision = decideLinkClickWrite({
      isSender: false,
      priorClicks: countRow?.count ?? 0,
      hasRecentSameUrlClick: recent.length > 0,
    });
    if (decision !== 'record') {
      res.json({ ok: true });
      return;
    }

    // PD-9: clicked_at is always written from Node, so the dedupe cutoff and
    // the stored value use the same timestamp encoding.
    await db.insert(messageLinkClicks).values({
      messageId: msg.id,
      conversationId,
      userId,
      url: key,
      source: parse.data.source,
      platform: parse.data.platform,
      clickedAt: now,
    });
    res.json({ ok: true });
  } catch (err) {
    // PD-4: the table is not there yet (migration 0046 not applied). Scoped to
    // THIS table; any other missing relation stays a real error.
    if (isMissingRelationError(err, 'message_link_clicks')) {
      if (!warnedMissingTable) {
        warnedMissingTable = true;
        log.warn('[link-clicks] message_link_clicks table missing — migration 0046 not applied yet; clicks are dropped');
      }
      res.json({ ok: true });
      return;
    }
    log.error({ err, messageId }, '[link-clicks] record failed');
    res.status(500).json({ error: 'Could not record link click' });
  }
});

export default router;
