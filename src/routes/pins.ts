import { Router, Request, Response } from 'express';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { messages, conversations, conversationParticipants, pinnedMessages } from '../db/schema';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { announcePinAction, PinEventPayload } from '../services/pinAnnounce';
import logger from '../lib/logger';

const log = logger.child({ module: 'pins' });
const router = Router();
router.use(requireAuth);

/**
 * CR-01: A single logical timezone zone is addressed by two different roomId
 * keys depending on the screen — `timezone:<slug>` (Local Chat) vs
 * `globe:<slug>` (Globe view) — but both share the same `globe-feed:<slug>`
 * message feed. Canonicalize the pin key to the globe-feed slug identity before
 * EVERY DB op (GET lookup, POST upsert + onConflict target, DELETE) so a zone
 * has exactly one pin identity regardless of which screen pinned it. This is
 * server-side only — the mobile screens keep posting their current roomId and
 * the server normalizes.
 */
function canonicalRoomId(roomId: string): string {
  if (roomId.startsWith('globe:')) return roomId;
  if (roomId.startsWith('timezone:')) return 'globe:' + roomId.slice('timezone:'.length);
  return roomId;
}

/**
 * WR-06: Max length of the denormalized pin preview text. The server stores a
 * preview capped at this length, appending an ellipsis when it truncates, so
 * the client renders `previewText` verbatim (no client-side re-truncation that
 * could never fire). Keep this in lock-step with the mobile PIN_PREVIEW_MAX_LEN.
 */
const PIN_PREVIEW_MAX_LEN = 60;

function buildPreviewText(content: string | null | undefined): string | null {
  if (content == null) return null;
  return content.length > PIN_PREVIEW_MAX_LEN
    ? content.slice(0, PIN_PREVIEW_MAX_LEN) + '…'
    : content;
}

// ── Shared validation ──────────────────────────────────────────────────────

// Base object: roomId XOR conversationId (V5)
const roomOrConvBase = z.object({
  roomId: z.string().max(100).optional(),
  conversationId: z.coerce.number().int().positive().optional(),
});

const xorRefine = (d: { roomId?: string; conversationId?: number }) =>
  (d.roomId != null) !== (d.conversationId != null);
const xorMsg = { message: 'Exactly one of roomId or conversationId is required' };

// roomId XOR conversationId: exactly one must be present (V5)
const roomOrConvSchema = roomOrConvBase.refine(xorRefine, xorMsg);

const pinBodySchema = roomOrConvBase.extend({
  messageId: z.number().int().positive(),
}).refine(xorRefine, xorMsg);

const unpinBodySchema = roomOrConvSchema;

// ── GET /api/pins — return the current pin for a room or conversation ──────

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = roomOrConvSchema.safeParse({
    roomId: req.query.roomId,
    conversationId: req.query.conversationId,
  });
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }
  const { roomId, conversationId } = parse.data;
  // CR-01: collapse timezone:<slug> → globe:<slug> so both screens read one pin.
  const canonRoomId = roomId != null ? canonicalRoomId(roomId) : undefined;

  const rows = await db
    .select()
    .from(pinnedMessages)
    .where(
      canonRoomId != null
        ? eq(pinnedMessages.roomId, canonRoomId)
        : eq(pinnedMessages.conversationId, conversationId!),
    )
    .limit(1);

  res.json({ pin: rows[0] ?? null });
});

// ── Authority helper ──────────────────────────────────────────────────────

/**
 * Server-side authority check for pin/unpin. Returns null on success, or
 * a { status, error } object when the caller is not authorized.
 * Authority is scoped per surface (D-02..D-05):
 *   - community room (roomId present) → req.user.isStaff (D-03/D-05)
 *   - group conversation → caller has role='admin' in conversation_participants (D-02)
 *   - DM conversation → caller is any active participant (D-04)
 * Staff authority does NOT extend to groups or DMs (D-05).
 */
async function checkPinAuthority(
  req: AuthRequest,
  roomId: string | undefined,
  conversationId: number | undefined,
): Promise<{ status: number; error: string } | null> {
  const userId = req.user!.id;

  if (roomId != null) {
    // Community room: require global staff flag (D-03, D-05)
    if (!req.user!.isStaff) {
      return { status: 403, error: 'Only staff can pin messages in community rooms' };
    }
    return null;
  }

  // Conversation path: load conversation to determine group vs DM
  const [conversation] = await db
    .select({ id: conversations.id, isGroup: conversations.isGroup })
    .from(conversations)
    .where(eq(conversations.id, conversationId!))
    .limit(1);

  if (!conversation) {
    return { status: 404, error: 'Conversation not found' };
  }

  if (conversation.isGroup === true) {
    // Group: require role='admin' in conversation_participants (D-02)
    const [participant] = await db
      .select({ role: conversationParticipants.role })
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, conversationId!),
          eq(conversationParticipants.userId, userId),
          isNull(conversationParticipants.leftAt),
        ),
      )
      .limit(1);

    if (!participant || participant.role !== 'admin') {
      return { status: 403, error: 'Only group admins can pin messages' };
    }
  } else {
    // DM: require active participant — any role (D-04)
    const [participant] = await db
      .select({ id: conversationParticipants.id })
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, conversationId!),
          eq(conversationParticipants.userId, userId),
          isNull(conversationParticipants.leftAt),
        ),
      )
      .limit(1);

    if (!participant) {
      return { status: 403, error: 'Only participants can pin messages in a DM' };
    }
  }

  return null;
}

// ── POST /api/pins — pin a message ────────────────────────────────────────

router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = pinBodySchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }
  const { roomId, conversationId, messageId } = parse.data;
  const userId = req.user!.id;
  // CR-01: canonical key for storage/upsert. Message-ownership and authority
  // checks below use the ORIGINAL roomId (that is what messages.roomId carries);
  // only the pinned_messages row key is normalized to the globe-feed slug.
  const canonRoomId = roomId != null ? canonicalRoomId(roomId) : undefined;

  // 1. Load the target message
  const [message] = await db
    .select({
      id: messages.id,
      kind: messages.kind,
      roomId: messages.roomId,
      conversationId: messages.conversationId,
      content: messages.content,
      mediaUrls: messages.mediaUrls,
      senderId: messages.senderId,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);

  if (!message) {
    res.status(404).json({ error: 'message not found' });
    return;
  }

  // 2. Only user messages are pinnable (D-10 — system messages not pinnable)
  if (message.kind !== 'user') {
    res.status(422).json({ error: 'only user messages can be pinned' });
    return;
  }

  // 3. V5: reject if message does not belong to the target room/conversation
  if (roomId != null && message.roomId !== roomId) {
    res.status(422).json({ error: 'message does not belong to this room' });
    return;
  }
  if (conversationId != null && message.conversationId !== conversationId) {
    res.status(422).json({ error: 'message does not belong to this room' });
    return;
  }

  // 4. Server-side authority check (V4 — never trust client)
  const authErr = await checkPinAuthority(req, roomId, conversationId);
  if (authErr) {
    res.status(authErr.status).json({ error: authErr.error });
    return;
  }

  // Derive denormalized preview fields from the loaded message (WR-06: the
  // preview carries an ellipsis when truncated so the client renders it as-is)
  const previewText = buildPreviewText(message.content);
  const pinnedMediaUrl = message.mediaUrls?.[0] ?? null;

  // Load the sender's handle for the preview (best-effort; null if senderId null)
  let pinnedSenderHandle: string | null = null;
  if (message.senderId) {
    const { userProfiles } = await import('../db/schema');
    const [profile] = await db
      .select({ handle: userProfiles.handle })
      .from(userProfiles)
      .where(eq(userProfiles.userId, message.senderId))
      .limit(1);
    pinnedSenderHandle = profile?.handle ?? null;
  }

  const pinnedAt = new Date();

  // 5. Upsert — replace-on-repin (D-08): partial unique index → onConflictDoUpdate
  const [pinRow] = await db
    .insert(pinnedMessages)
    .values({
      roomId: canonRoomId ?? null,
      conversationId: conversationId ?? null,
      messageId,
      pinnedById: userId,
      pinnedAt,
      previewText,
      pinnedMediaUrl,
      pinnedSenderHandle,
    })
    .onConflictDoUpdate({
      target: roomId != null ? [pinnedMessages.roomId] : [pinnedMessages.conversationId],
      // Match the PARTIAL unique index predicate (pinned_messages_room_uniq /
      // pinned_messages_conv_uniq are `WHERE <col> IS NOT NULL`). Without this,
      // Postgres rejects with "no unique or exclusion constraint matching the
      // ON CONFLICT specification" because a partial index only infers when the
      // statement repeats its WHERE clause.
      targetWhere:
        roomId != null
          ? sql`${pinnedMessages.roomId} IS NOT NULL`
          : sql`${pinnedMessages.conversationId} IS NOT NULL`,
      set: {
        messageId,
        pinnedById: userId,
        pinnedAt,
        previewText,
        pinnedMediaUrl,
        pinnedSenderHandle,
      },
    })
    .returning();

  const pinPayload: PinEventPayload = {
    action: 'pin',
    ...(roomId != null ? { roomId } : { conversationId }),
    pin: {
      id: pinRow.id,
      messageId: pinRow.messageId,
      pinnedAt: pinRow.pinnedAt.toISOString(),
      previewText: pinRow.previewText,
      pinnedMediaUrl: pinRow.pinnedMediaUrl,
      pinnedSenderHandle: pinRow.pinnedSenderHandle,
    },
  };

  // 6. Announce system line + broadcast pin event. Capture the created system
  // message so the actor's own client can append it immediately (deduped by id
  // against the socket echo) — fixes the actor-doesn't-see-own-pin-line bug.
  //
  // WR-05 (best-effort, intentional): the pin row write (step 5) and the
  // announce system-message insert + conversations.lastMessageAt bump are NOT
  // wrapped in a single db.transaction. announcePinAction catches its own
  // errors and returns null, so a failure there leaves the pin persisted with
  // no system line / bump (systemMessage:null). This is accepted: the pin
  // itself is the source of truth (the PinnedBar reads the pin row), the system
  // line is a cosmetic announcement, and every client surface already tolerates
  // systemMessage:null (globe/local/DM screens early-return on null). A shared
  // transaction is avoided here because announce performs socket I/O (io.emit)
  // that must not run inside an open DB transaction.
  const systemMessage = await announcePinAction({
    roomId,
    conversationId,
    userId,
    handle: req.user!.handle ?? String(userId),
    action: 'pin',
    pinPayload,
  });

  log.info({ userId, messageId, roomId, conversationId }, 'message pinned');

  // 7. Respond
  res.json({ ok: true, pin: pinRow, systemMessage });
});

// ── DELETE /api/pins — unpin the current pin ──────────────────────────────

router.delete('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = unpinBodySchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }
  const { roomId, conversationId } = parse.data;
  const userId = req.user!.id;
  // CR-01: delete the canonical row so unpin from either screen clears the
  // single shared pin (authority check still uses the original roomId).
  const canonRoomId = roomId != null ? canonicalRoomId(roomId) : undefined;

  // Same authority check as POST — same surface = same authority (D-02/D-08)
  const authErr = await checkPinAuthority(req, roomId, conversationId);
  if (authErr) {
    res.status(authErr.status).json({ error: authErr.error });
    return;
  }

  await db
    .delete(pinnedMessages)
    .where(
      canonRoomId != null
        ? eq(pinnedMessages.roomId, canonRoomId)
        : eq(pinnedMessages.conversationId, conversationId!),
    );

  const pinPayload: PinEventPayload = {
    action: 'unpin',
    ...(roomId != null ? { roomId } : { conversationId }),
    pin: null,
  };

  const systemMessage = await announcePinAction({
    roomId,
    conversationId,
    userId,
    handle: req.user!.handle ?? String(userId),
    action: 'unpin',
    pinPayload,
  });

  log.info({ userId, roomId, conversationId }, 'message unpinned');

  res.json({ ok: true, systemMessage });
});

export default router;
