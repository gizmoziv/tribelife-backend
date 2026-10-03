// Link-click analytics routes (quick 261003-nfu).
//
// Mounted INSIDE the chat router after requireAuth + requireApprovedAccess
// (never in server.ts), so auth runs once. The write path records taps for
// every sender (D1); the read path is for premium senders only (display gate).
//
//   POST /api/chat/messages/:id/link-clicks   → { ok: true }
//   GET  /api/chat/messages/:id/link-analytics → { links: [{ url, clicks, uniqueClickers }] }
//
// Fail-soft: until migration 0046 is applied the POST answers { ok: true } and
// logs one warning, and the GET answers 503. Only a missing message_link_clicks
// relation is handled this way; any other error is a logged 500.
//
// D3: counts include everyone. The read-receipt preferences are NOT consulted
// here; they are reserved for a future display-time who-clicked view.

import { Router, Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  messages,
  conversations,
  conversationParticipants,
  messageLinkClicks,
} from '../db/schema';
import type { AuthRequest } from '../middleware/auth';
import { requireCapability } from '../middleware/capabilities';
import logger from '../lib/logger';
import { linkKey, messageLinkKeys } from '../utils/messageLinks';
import {
  aggregateLinkClicks,
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

// ── Per-link click counts for the sender (premium display gate) ─────────────
router.get('/messages/:id/link-analytics', requireCapability('canViewLinkAnalytics', 'Link click analytics are a Premium feature'), async (req: AuthRequest, res: Response): Promise<void> => {
  const messageId = parseInt(req.params.id as string);
  try {
    const userId = req.user!.id;
    if (isNaN(messageId) || messageId <= 0) {
      res.status(400).json({ error: 'Invalid message ID' });
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

    if (msg.senderId !== userId) {
      res.status(403).json({ error: 'Only the sender can view link analytics' });
      return;
    }

    const [conversation] = await db
      .select({ isGroup: conversations.isGroup })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!isLinkAnalyticsConversation(conversation)) {
      res.status(422).json({ error: 'Link analytics are only available for group messages' });
      return;
    }

    // A removed sender stops receiving group activity data.
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

    const linkKeys = messageLinkKeys(msg.content);
    if (linkKeys.length === 0) {
      res.json({ links: [] });
      return;
    }

    // One row per (url, clicker) keeps the result bounded by members x links.
    // No read-receipt preference filter: counts include everyone (D3).
    const rows = await db
      .select({
        url: messageLinkClicks.url,
        userId: messageLinkClicks.userId,
        clicks: sql<number>`count(*)::int`,
      })
      .from(messageLinkClicks)
      .where(and(
        eq(messageLinkClicks.messageId, msg.id),
        inArray(messageLinkClicks.url, linkKeys),
      ))
      .groupBy(messageLinkClicks.url, messageLinkClicks.userId);

    res.json({ links: aggregateLinkClicks(linkKeys, rows, msg.senderId) });
  } catch (err) {
    if (isMissingRelationError(err, 'message_link_clicks')) {
      res.status(503).json({ error: 'Link analytics are not available yet' });
      return;
    }
    log.error({ err, messageId }, '[link-clicks] analytics failed');
    res.status(500).json({ error: 'Could not load link analytics' });
  }
});

export default router;
