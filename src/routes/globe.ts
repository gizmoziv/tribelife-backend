import { Router, Response } from 'express';
import {
  eq,
  ne,
  desc,
  lt,
  and,
  inArray,
  notInArray,
  gt,
  isNull,
  sql,
  count,
} from 'drizzle-orm';
import { z } from 'zod';
import { Server } from 'socket.io';
import { db } from '../db';
import {
  messages,
  users,
  userProfiles,
  blockedUsers,
  globeReadPositions,
  globeRoomMemberships,
  conversations,
  conversationParticipants,
} from '../db/schema';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { attachReactions } from '../utils/attachReactions';
import { attachReplyTo } from '../utils/attachReplyTo';
import { redactDeletedMessages } from '../utils/redactDeleted';
import {
  GLOBE_ROOMS,
  isValidGlobeRoom,
  getRegionForTimezone,
  getGlobeRoom,
} from '../config/globeRooms';
import {
  isValidTimezoneRoom,
  TIMEZONE_ZONES,
  getZoneForTimezone,
} from '../config/timezoneZones';
import {
  callerCanAccessNonNativeTimezone,
  isCallerNativeForSlug,
  timezoneRoomId,
} from '../lib/timezoneRoomAccess';
import { getCapabilities } from '../middleware/capabilities';
import { logCapabilityDenial } from '../lib/capabilityLogger';

const router = Router();
router.use(requireAuth);

// ── aroundMessageId query param schema (D-04) ─────────────────────────────────
// Phase 14 D-04: around-message window schema.
// IMPORTANT: existing `?before=<ISO timestamp>` is the OLDER-MESSAGES cursor.
// We reuse `before` as a COUNT only when aroundMessageId is present. To avoid
// the timestamp string failing z.coerce.number(), accept either a coercible
// number OR ignore the field (default applied) when it can't be coerced.
// Bug: prior schema unconditionally coerced before/after → existing
// /messages?before=<iso> calls 400'd with "Expected number, received nan".
const beforeAfterCount = z
  .union([z.coerce.number().int().min(0).max(50), z.string()])
  .optional()
  .transform((v) => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    return undefined;
  });

const aroundMessageSchema = z.object({
  aroundMessageId: z.coerce.number().int().positive().optional(),
  before: beforeAfterCount,
  after: beforeAfterCount,
});

// ── Per-row enrichment helpers ───────────────────────────────────────────────
// Shared by the combined legacy `GET /rooms` path and the Phase 18 per-section
// paginated path (`?section=…`). Single source of truth for each row shape so
// the two code paths can never drift. Pure extractions of the original inline
// map bodies — behavior is byte-identical to the pre-Phase-18 handler.

async function enrichRegionRow(
  io: Server,
  room: (typeof GLOBE_ROOMS)[number],
  suggestedRegion: string | null,
  memberSlugs: Set<string>,
) {
  const realCount = io.sockets.adapter.rooms.get(room.roomId)?.size ?? 0;
  const participantCount =
    realCount > 0 ? realCount : Math.floor(Math.random() * 10) + 1;

  const [lastMsg] = await db
    .select({
      content: messages.content,
      createdAt: messages.createdAt,
      senderHandle: userProfiles.handle,
    })
    .from(messages)
    .leftJoin(userProfiles, eq(userProfiles.userId, messages.senderId))
    .where(eq(messages.roomId, room.roomId))
    .orderBy(desc(messages.createdAt))
    .limit(1);

  return {
    kind: 'globe_room' as const,
    slug: room.slug,
    displayName: room.displayName,
    participantCount,
    lastMessage: lastMsg
      ? {
          content: lastMsg.content,
          createdAt: lastMsg.createdAt,
          senderHandle: lastMsg.senderHandle,
        }
      : null,
    isSuggested: room.slug === suggestedRegion,
    isGlobal: room.isGlobal,
    sortOrder: room.sortOrder,
    welcomeMessage: room.welcomeMessage,
    isMember: memberSlugs.has(room.slug),
    autoJoin: room.autoJoin,
  };
}

async function enrichGroupRow(
  row: {
    conversationId: number;
    name: string | null;
    iconUrl: string | null;
    inviteSlug: string | null;
    memberCount: number;
  },
  isMember: boolean,
) {
  const [lastMsg] = await db
    .select({
      content: messages.content,
      createdAt: messages.createdAt,
      senderHandle: userProfiles.handle,
    })
    .from(messages)
    .leftJoin(userProfiles, eq(userProfiles.userId, messages.senderId))
    .where(and(eq(messages.conversationId, row.conversationId), isNull(messages.deletedAt)))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return {
    kind: 'group' as const,
    conversationId: row.conversationId,
    name: row.name ?? 'Group',
    iconUrl: row.iconUrl ?? null,
    inviteSlug: row.inviteSlug ?? '',
    memberCount: Number(row.memberCount ?? 0),
    isMember,
    lastMessage: lastMsg
      ? {
          content: lastMsg.content,
          createdAt: (lastMsg.createdAt as Date).toISOString(),
          senderHandle: lastMsg.senderHandle ?? '',
        }
      : null,
  };
}

async function enrichTimezoneRow(
  z: (typeof TIMEZONE_ZONES)[number],
  callerCanAccess: boolean,
  joinedTimezoneSlugs: Set<string>,
) {
  const roomId = timezoneRoomId(z.slug);

  // memberCount: native TZ membership is IMPLICIT via user_profiles.timezone;
  // explicit cross-zone retainer rows live in globe_room_memberships. Sum both,
  // deduping the rare overlap via the notInArray subquery. (See the original
  // inline block for the full rationale — Phase 15 TZRM-02.)
  const implicitNativeUserIds = db
    .select({ userId: userProfiles.userId })
    .from(userProfiles)
    .where(inArray(userProfiles.timezone, z.members));
  const [implicitCount, explicitCount] = await Promise.all([
    db
      .select({ c: count() })
      .from(userProfiles)
      .where(inArray(userProfiles.timezone, z.members)),
    db
      .select({ c: count() })
      .from(globeRoomMemberships)
      .where(and(
        eq(globeRoomMemberships.roomSlug, z.slug),
        notInArray(globeRoomMemberships.userId, implicitNativeUserIds),
      )),
  ]);
  const memberCount =
    Number(implicitCount[0]?.c ?? 0) + Number(explicitCount[0]?.c ?? 0);

  // lastMessage: D-03 — free callers always get null (no preview);
  // premium/org_admin get the real last-message preview.
  let lastMessage:
    | { content: string; createdAt: string; senderHandle: string }
    | null = null;
  if (callerCanAccess) {
    const [lastMsg] = await db
      .select({
        content: messages.content,
        createdAt: messages.createdAt,
        senderHandle: userProfiles.handle,
      })
      .from(messages)
      .leftJoin(userProfiles, eq(userProfiles.userId, messages.senderId))
      .where(eq(messages.roomId, roomId))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    if (lastMsg) {
      lastMessage = {
        content: lastMsg.content ?? '',
        createdAt: (lastMsg.createdAt as Date).toISOString(),
        senderHandle: lastMsg.senderHandle ?? '',
      };
    }
  }

  return {
    kind: 'timezone_room' as const,
    slug: z.slug,
    displayName: z.displayName,
    memberCount,
    lastMessage,
    isMember: joinedTimezoneSlugs.has(z.slug),
    paywalled: !callerCanAccess,
  };
}

// ── Phase 18: per-section Chevra pagination ──────────────────────────────────
// Additive discovery surface. Each section is its own horizontal carousel on the
// mobile client; this returns one offset/limit page of a single section plus a
// `hasMore` flag. Unlike the legacy combined path, the discovery sections EXCLUDE
// rooms the caller has already joined (and Town Square), so `hasMore`/counts
// reflect what's actually offered. Enrichment runs on the page only — far cheaper
// than the legacy "enrich everything" path.
type ChevraSectionName = 'regions' | 'chavurot' | 'timezones';

async function buildChevraSection(opts: {
  section: ChevraSectionName;
  limit: number;
  offset: number;
  q: string;
  io: Server;
  userId: number;
  profileTimezone: string;
  memberSlugs: Set<string>;
  suggestedRegion: string | null;
  req: AuthRequest;
}) {
  const { section, limit, offset, q, io, userId, profileTimezone, memberSlugs, suggestedRegion, req } = opts;

  if (section === 'regions') {
    // Discovery = non-Town-Square regions the caller has NOT joined.
    const all = GLOBE_ROOMS.filter(
      (r) => r.slug !== 'town-square' && !memberSlugs.has(r.slug),
    )
      .filter((r) => !q || r.displayName.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => {
        const aSug = a.slug === suggestedRegion ? 1 : 0;
        const bSug = b.slug === suggestedRegion ? 1 : 0;
        if (aSug !== bSug) return bSug - aSug;
        return a.sortOrder - b.sortOrder;
      });
    const pageItems = all.slice(offset, offset + limit);
    const rows = await Promise.all(
      pageItems.map((room) => enrichRegionRow(io, room, suggestedRegion, memberSlugs)),
    );
    return { section, rows, offset, limit, hasMore: offset + pageItems.length < all.length };
  }

  if (section === 'chavurot') {
    // Public groups the caller is NOT a member of, paginated by lastMessageAt DESC.
    // The non-member predicate is enforced in SQL (NOT EXISTS) so `hasMore` is
    // accurate. We over-fetch one row (limit+1) to derive hasMore without a
    // separate COUNT query. ORDER BY lastMessageAt DESC shifts as people post —
    // acceptable for a discovery surface at this scale (keyset is the upgrade path).
    const raw = await db
      .select({
        conversationId: conversations.id,
        name: conversations.groupName,
        iconUrl: conversations.groupIconUrl,
        inviteSlug: conversations.inviteSlug,
        memberCount: sql<number>`(
          SELECT count(*)::int FROM conversation_participants cp2
          WHERE cp2.conversation_id = conversations.id AND cp2.left_at IS NULL
        )`,
      })
      .from(conversations)
      .where(and(
        eq(conversations.isGroup, true),
        eq(conversations.isPublic, true),
        isNull(conversations.archivedAt),
        ...(q ? [sql`group_name ILIKE ${'%' + q + '%'}`] : []),
        sql`NOT EXISTS (
          SELECT 1 FROM conversation_participants cpm
          WHERE cpm.conversation_id = conversations.id
            AND cpm.user_id = ${userId}
            AND cpm.left_at IS NULL
        )`,
      ))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(limit + 1)
      .offset(offset);
    const hasMore = raw.length > limit;
    const pageRaw = hasMore ? raw.slice(0, limit) : raw;
    const rows = await Promise.all(pageRaw.map((row) => enrichGroupRow(row, false)));
    return { section, rows, offset, limit, hasMore };
  }

  // section === 'timezones'
  const caps = await getCapabilities(req);
  const callerCanAccess = callerCanAccessNonNativeTimezone(caps);
  const callerNativeSlug = getZoneForTimezone(profileTimezone);
  const joinedTimezoneSlugs = new Set(
    [...memberSlugs].filter((s) => isValidTimezoneRoom(s)),
  );
  const all = TIMEZONE_ZONES.filter((z) => z.slug !== callerNativeSlug)
    .filter((z) => z.slug !== 'utc')
    .filter((z) => (callerCanAccess ? !joinedTimezoneSlugs.has(z.slug) : true))
    .filter((z) => !q || z.displayName.toLowerCase().includes(q.toLowerCase()));
  const pageItems = all.slice(offset, offset + limit);
  const rows = await Promise.all(
    pageItems.map((z) => enrichTimezoneRow(z, callerCanAccess, joinedTimezoneSlugs)),
  );
  return { section, rows, offset, limit, hasMore: offset + pageItems.length < all.length };
}

// ── List all Globe rooms with live metadata ─────────────────────────────────
router.get('/rooms', async (req: AuthRequest, res: Response): Promise<void> => {
  const io = req.app.get('io') as Server;
  const userId = req.user!.id;

  // SRCH-03 (D-11): optional ?q= filter — any non-empty string accepted, no 3-char min.
  // When absent/empty, behavior is byte-identical to the pre-D-11 response.
  const q = (req.query.q ?? '').toString().trim();

  // Get user's timezone for auto-suggestion
  const [profile] = await db
    .select({ timezone: userProfiles.timezone })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);

  const suggestedRegion = getRegionForTimezone(profile?.timezone ?? 'UTC');

  // Phase 11 D-03: derive isMember per room via a single membership query
  const memberships = await db
    .select({ roomSlug: globeRoomMemberships.roomSlug })
    .from(globeRoomMemberships)
    .where(eq(globeRoomMemberships.userId, userId));
  const memberSlugs = new Set(memberships.map((m) => m.roomSlug));

  // ── Phase 18: optional per-section pagination ──────────────────────────────
  // Additive. When ?section is one of the three discovery carousels we return a
  // single paginated section and stop. When ?section is absent the handler falls
  // through to the byte-identical legacy combined response below, so old clients
  // (MIN_CLIENT_VERSION-gated) are completely unaffected.
  const sectionParam = (req.query.section ?? '').toString().trim();
  const section: ChevraSectionName | null =
    sectionParam === 'regions' || sectionParam === 'chavurot' || sectionParam === 'timezones'
      ? sectionParam
      : null;
  if (section !== null) {
    const limit = Math.min(
      Math.max(parseInt((req.query.limit as string) || '12', 10) || 12, 1),
      30,
    );
    const offset = Math.max(parseInt((req.query.offset as string) || '0', 10) || 0, 0);
    const page = await buildChevraSection({
      section,
      limit,
      offset,
      q,
      io,
      userId,
      profileTimezone: profile?.timezone ?? 'UTC',
      memberSlugs,
      suggestedRegion,
      req,
    });
    if (q) {
      console.info(
        '[globe] section=' + section + ' q=' + JSON.stringify(q) + ' results=' + page.rows.length,
      );
    }
    res.json(page);
    return;
  }

  // SRCH-03: in-memory filter on GLOBE_ROOMS config (no globe_rooms table — RESEARCH delta #1).
  // O(8) — negligible. Empty q → matchingGlobeRooms === GLOBE_ROOMS (no-op filter).
  const matchingGlobeRooms = q
    ? GLOBE_ROOMS.filter((r) => r.displayName.toLowerCase().includes(q.toLowerCase()))
    : GLOBE_ROOMS;

  const rooms = await Promise.all(
    matchingGlobeRooms.map((room) =>
      enrichRegionRow(io, room, suggestedRegion, memberSlugs),
    ),
  );

  // Phase 11 D-06: server-owned ordering — user's region first (per
  // isSuggested), then remaining rooms by sortOrder ASC. Town Square is
  // included in the response (existing contract); the mobile screen
  // continues to filter it out client-side via the existing
  // `globe/index.tsx:154` line.
  rooms.sort((a, b) => {
    const aIsUserRegion = a.isSuggested ? 1 : 0;
    const bIsUserRegion = b.isSuggested ? 1 : 0;
    if (aIsUserRegion !== bIsUserRegion) return bIsUserRegion - aIsUserRegion;
    return a.sortOrder - b.sortOrder;
  });

  // Phase 12 D-04 + D-08: public-group UNION — appended after globe rooms
  // (ordered by lastMessageAt DESC per D-08). Filters: isPublic=true,
  // archivedAt IS NULL. LIMIT 50 safety ceiling.
  // SRCH-03: when q is non-empty, add group_name ILIKE filter that lights up
  // conversations_group_name_trgm_idx from Plan 01.
  const publicGroupsRaw = await db
    .select({
      conversationId: conversations.id,
      name: conversations.groupName,
      iconUrl: conversations.groupIconUrl,
      inviteSlug: conversations.inviteSlug,
      lastMessageAt: conversations.lastMessageAt,
      // Drizzle's `${conversations.id}` interpolation emits an unqualified
      // `"id"` reference, which PostgreSQL resolves against the inner scope
      // (cp2.id) — silently turning this into `cp2.conversation_id = cp2.id`
      // and counting at most one matching row per group. Use the explicit
      // qualified reference `conversations.id` inline instead.
      memberCount: sql<number>`(
        SELECT count(*)::int FROM conversation_participants cp2
        WHERE cp2.conversation_id = conversations.id AND cp2.left_at IS NULL
      )`,
    })
    .from(conversations)
    .where(and(
      eq(conversations.isGroup, true),
      eq(conversations.isPublic, true),
      isNull(conversations.archivedAt),
      ...(q ? [sql`group_name ILIKE ${'%' + q + '%'}`] : []),
    ))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(50);

  // Derive isMember via a separate participant lookup — mirrors the globe-room
  // memberships pattern above. Avoids the inline-EXISTS userId binding issue
  // and keeps the query path consistent across both row kinds.
  const publicGroupIds = publicGroupsRaw.map((r) => r.conversationId);
  const memberConversationIds = publicGroupIds.length
    ? await db
        .select({ conversationId: conversationParticipants.conversationId })
        .from(conversationParticipants)
        .where(and(
          eq(conversationParticipants.userId, userId),
          isNull(conversationParticipants.leftAt),
          inArray(conversationParticipants.conversationId, publicGroupIds),
        ))
    : [];
  const memberGroupIdSet = new Set(memberConversationIds.map((m) => m.conversationId));

  // Last-message preview per group (N+1 — mirrors chats.ts group N+1 pattern)
  const publicGroupRows = await Promise.all(
    publicGroupsRaw.map((row) =>
      enrichGroupRow(row, memberGroupIdSet.has(row.conversationId)),
    ),
  );

  // ── Phase 15 TZRM-02: timezone_room variants ─────────────────────────────
  // D-10: caller's native zone is hidden (already implicit via Local Chat
  // row[0] in /api/chats). For premium/org_admin, joined non-native rooms
  // are also hidden (same pattern as joined groups in Phase 12). For free
  // callers, all non-native zones surface with paywalled=true + lastMessage
  // null (D-03 — no content preview). `utc` is the fallback slug, never
  // surfaced in discovery.
  const caps = await getCapabilities(req);
  const callerCanAccess = callerCanAccessNonNativeTimezone(caps);
  const callerNativeSlug = getZoneForTimezone(profile?.timezone ?? 'UTC');
  const joinedTimezoneSlugs = new Set(
    [...memberSlugs].filter((s) => isValidTimezoneRoom(s)),
  );

  const timezoneRoomRows = await Promise.all(
    TIMEZONE_ZONES
      .filter((z) => z.slug !== callerNativeSlug)
      .filter((z) => z.slug !== 'utc')
      .filter((z) => {
        // D-10: premium/org_admin — hide rooms they've already joined.
        // Free callers — show ALL non-native (can't legitimately have a
        // non-native membership row as free; D-08 read-path gate prevents).
        if (callerCanAccess) return !joinedTimezoneSlugs.has(z.slug);
        return true;
      })
      // SRCH-03 ?q= filter — in-memory like the globe-room filter.
      .filter((z) => !q || z.displayName.toLowerCase().includes(q.toLowerCase()))
      .map((z) => enrichTimezoneRow(z, callerCanAccess, joinedTimezoneSlugs)),
  );

  const responseRows = [...rooms, ...publicGroupRows, ...timezoneRoomRows];
  // SRCH-03: log every ?q= request (q is safe to log — public-discovery surface,
  // no PII in globe-room or group names per security_threat_model T-14-04-I-q).
  if (q) {
    console.info('[globe] q=' + JSON.stringify(q) + ' results=' + responseRows.length);
  }
  res.json({ rooms: responseRows });
});

// ── Get paginated message history for a Globe room ──────────────────────────
router.get(
  '/rooms/:slug/messages',
  async (req: AuthRequest, res: Response): Promise<void> => {
    const slug = req.params.slug as string;
    // Phase 15 (D-08, TZRM-01): slug may be a globe-room OR a timezone-room.
    // Namespaces are disjoint (Plan 15-01 acceptance) — exactly one predicate
    // returns true for valid slugs. Both false → 404.
    const isGlobe = isValidGlobeRoom(slug);
    const isTimezone = isValidTimezoneRoom(slug);
    if (!isGlobe && !isTimezone) {
      res.status(404).json({ error: 'Room not found' });
      return;
    }

    const userId = req.user!.id;

    // D-08 read-time cap check: non-native timezone room requires premium /
    // org_admin even when a globe_room_memberships row exists. Membership
    // alone is NOT sufficient.
    if (isTimezone && !isCallerNativeForSlug(req.user!.timezone ?? 'UTC', slug)) {
      const caps = await getCapabilities(req);
      if (!callerCanAccessNonNativeTimezone(caps)) {
        logCapabilityDenial({
          req,
          capability: 'tzroom:non-native-read',
          currentTier: caps.tier,
          reason: 'feature',
        });
        res.status(403).json({
          error: 'Premium required to read non-native timezone rooms',
          capabilityViolation: true,
        });
        return;
      }
    }

    const roomId = isTimezone ? timezoneRoomId(slug) : 'globe:' + slug;

    // Parse aroundMessageId params — validation error is cheapest to return
    const aroundParse = aroundMessageSchema.safeParse(req.query);
    if (!aroundParse.success) {
      res.status(400).json({ error: aroundParse.error.errors[0].message });
      return;
    }
    const { aroundMessageId, before: beforeRaw, after: afterRaw } = aroundParse.data;
    // Default to 25 when caller omitted the count or sent a non-numeric value
    // (e.g. ?before=<ISO> for the existing older-cursor pagination path).
    const beforeCount = typeof beforeRaw === 'number' ? beforeRaw : 25;
    const afterCount = typeof afterRaw === 'number' ? afterRaw : 25;

    const cursor = req.query.before && !aroundMessageId
      ? new Date(req.query.before as string)
      : undefined;
    const limit = Math.min(parseInt((req.query.limit as string) ?? '50'), 100);

    // Get blocked user IDs to exclude their messages
    const blockedRows = await db
      .select({ blockedUserId: blockedUsers.blockedUserId })
      .from(blockedUsers)
      .where(eq(blockedUsers.userId, userId));
    const blockedIds = blockedRows.map((r) => r.blockedUserId);

    // ── aroundMessageId path (D-04) ──────────────────────────────────────────
    if (aroundMessageId !== undefined) {
      // Fetch target row — must exist, belong to this globe room, and not be deleted
      const [target] = await db
        .select({
          id: messages.id,
          roomId: messages.roomId,
          createdAt: messages.createdAt,
          deletedAt: messages.deletedAt,
        })
        .from(messages)
        .where(eq(messages.id, aroundMessageId))
        .limit(1);

      // T-14-03-I-grinding: mismatch or missing → 404
      if (
        !target ||
        target.roomId !== roomId ||
        target.deletedAt !== null
      ) {
        res.status(404).json({ error: 'message not found' });
        return;
      }

      const msgSelect = {
        id: messages.id,
        content: messages.content,
        createdAt: messages.createdAt,
        senderId: messages.senderId,
        senderName: users.name,
        senderHandle: userProfiles.handle,
        senderAvatar: userProfiles.avatarUrl,
        mentions: messages.mentions,
        mediaUrls: messages.mediaUrls,
        attachments: messages.attachments,
        // Without this, the mobile's `if (message.kind === 'system')` check
        // (MessageBubble.tsx) gets undefined for system rows fetched via
        // history (the join "@handle joined the chat" announcement from
        // auth.ts), so they render as regular bubbles instead of the
        // centered pill. The live socket payload already includes kind.
        kind: messages.kind,
        voiceUrl: messages.voiceUrl,
        voiceDurationMs: messages.voiceDurationMs,
        voiceWaveform: messages.voiceWaveform,
        voiceTranscript: messages.voiceTranscript,
      } as const;

      const targetCreatedAt = target.createdAt as Date;
      const targetId = target.id;

      // Build blocked-sender exclusion for before/after queries.
      // ne(id, targetId) guards against the target slipping into either half due
      // to JS-ms-vs-pg-µs precision mismatch in the keyset boundary value.
      const blockedClauseOlder = blockedIds.length > 0
        ? and(
            eq(messages.roomId, roomId),
            isNull(messages.deletedAt),
            ne(messages.id, targetId),
            sql`(${messages.createdAt}, ${messages.id}) < (${targetCreatedAt.toISOString()}::timestamptz, ${targetId})`,
            notInArray(messages.senderId, blockedIds),
          )
        : and(
            eq(messages.roomId, roomId),
            isNull(messages.deletedAt),
            ne(messages.id, targetId),
            sql`(${messages.createdAt}, ${messages.id}) < (${targetCreatedAt.toISOString()}::timestamptz, ${targetId})`,
          );

      const blockedClauseNewer = blockedIds.length > 0
        ? and(
            eq(messages.roomId, roomId),
            isNull(messages.deletedAt),
            ne(messages.id, targetId),
            sql`(${messages.createdAt}, ${messages.id}) > (${targetCreatedAt.toISOString()}::timestamptz, ${targetId})`,
            notInArray(messages.senderId, blockedIds),
          )
        : and(
            eq(messages.roomId, roomId),
            isNull(messages.deletedAt),
            ne(messages.id, targetId),
            sql`(${messages.createdAt}, ${messages.id}) > (${targetCreatedAt.toISOString()}::timestamptz, ${targetId})`,
          );

      const [olderRows, newerRows] = await Promise.all([
        db
          .select(msgSelect)
          .from(messages)
          .leftJoin(users, eq(users.id, messages.senderId))
          .leftJoin(userProfiles, eq(userProfiles.userId, messages.senderId))
          .where(blockedClauseOlder)
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(beforeCount),
        db
          .select(msgSelect)
          .from(messages)
          .leftJoin(users, eq(users.id, messages.senderId))
          .leftJoin(userProfiles, eq(userProfiles.userId, messages.senderId))
          .where(blockedClauseNewer)
          .orderBy(messages.createdAt, messages.id)
          .limit(afterCount),
      ]);

      // Fetch target in full projection shape
      const [targetFull] = await db
        .select(msgSelect)
        .from(messages)
        .leftJoin(users, eq(users.id, messages.senderId))
        .leftJoin(userProfiles, eq(userProfiles.userId, messages.senderId))
        .where(eq(messages.id, aroundMessageId))
        .limit(1);

      const window = [...olderRows.reverse(), targetFull, ...newerRows];
      const withReactions = await attachReactions(window, userId);
      const withReplies = await attachReplyTo(withReactions);
      res.json({ messages: withReplies });
      return;
    }

    // ── Existing pagination path (unchanged) ────────────────────────────────
    const baseWhere = cursor
      ? and(eq(messages.roomId, roomId), lt(messages.createdAt, cursor))
      : eq(messages.roomId, roomId);

    const whereClause =
      blockedIds.length > 0 && messages.senderId !== null
        ? and(baseWhere, notInArray(messages.senderId, blockedIds))
        : baseWhere;

    const rawRows = await db
      .select({
        id: messages.id,
        content: messages.content,
        createdAt: messages.createdAt,
        deletedAt: messages.deletedAt,
        senderId: messages.senderId,
        senderName: users.name,
        senderHandle: userProfiles.handle,
        senderAvatar: userProfiles.avatarUrl,
        mentions: messages.mentions,
        mediaUrls: messages.mediaUrls,
        attachments: messages.attachments,
        // Mirrors msgSelect above — see comment there for context.
        kind: messages.kind,
        voiceUrl: messages.voiceUrl,
        voiceDurationMs: messages.voiceDurationMs,
        voiceWaveform: messages.voiceWaveform,
        voiceTranscript: messages.voiceTranscript,
      })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.senderId))
      .leftJoin(userProfiles, eq(userProfiles.userId, messages.senderId))
      .where(whereClause)
      .orderBy(desc(messages.createdAt))
      .limit(limit);

    // Keep soft-deleted rows (persistent tombstone) but strip their content.
    const rows = redactDeletedMessages(rawRows);
    const withReactions = await attachReactions(rows, userId);
    const withReplies = await attachReplyTo(withReactions);
    res.json({
      messages: withReplies.reverse(),
      hasMore: rows.length === limit,
    });
  },
);

// ── Mark all Globe rooms as read ──────────────────────────────────────────
// Used by the bell's Mentions tab "Mark read" action so clearing mention
// notifications also clears the corresponding Globe tab unread signal.
router.put(
  '/rooms/mark-all-read',
  async (req: AuthRequest, res: Response): Promise<void> => {
    const userId = req.user!.id;
    const now = new Date();

    await Promise.all(
      GLOBE_ROOMS.map((room) =>
        db
          .insert(globeReadPositions)
          .values({ userId, roomSlug: room.slug, lastReadAt: now })
          .onConflictDoUpdate({
            target: [globeReadPositions.userId, globeReadPositions.roomSlug],
            set: { lastReadAt: now },
          }),
      ),
    );

    res.json({ ok: true });
  },
);

// ── Mark a Globe room or non-native timezone room as read ─────────────────
router.put(
  '/rooms/:slug/read',
  async (req: AuthRequest, res: Response): Promise<void> => {
    const slug = req.params.slug as string;
    // Phase 15 (TZRM-01): joined non-native timezone rooms share the same
    // `globe_read_positions` table; accept their zone slugs here too so the
    // mobile chat screen's mark-read call updates the read position and the
    // /api/chats unreadCount aggregate returns to 0 on next hydrate.
    if (!isValidGlobeRoom(slug) && !isValidTimezoneRoom(slug)) {
      res.status(404).json({ error: 'Room not found' });
      return;
    }

    const userId = req.user!.id;

    await db
      .insert(globeReadPositions)
      .values({ userId, roomSlug: slug, lastReadAt: new Date() })
      .onConflictDoUpdate({
        target: [globeReadPositions.userId, globeReadPositions.roomSlug],
        set: { lastReadAt: new Date() },
      });

    res.json({ ok: true });
  },
);

// ── Get unread counts for all Globe rooms ──────────────────────────────────
router.get(
  '/unread',
  async (req: AuthRequest, res: Response): Promise<void> => {
    const userId = req.user!.id;

    // Get all read positions for this user
    const readPositions = await db
      .select({
        roomSlug: globeReadPositions.roomSlug,
        lastReadAt: globeReadPositions.lastReadAt,
      })
      .from(globeReadPositions)
      .where(eq(globeReadPositions.userId, userId));

    const readMap = new Map(
      readPositions.map((r) => [r.roomSlug, r.lastReadAt]),
    );

    // Count unread messages per room in parallel
    const unread: Record<string, number> = {};

    await Promise.all(
      GLOBE_ROOMS.map(async (room) => {
        const lastRead = readMap.get(room.slug);
        const whereClause = lastRead
          ? and(
              eq(messages.roomId, room.roomId),
              gt(messages.createdAt, lastRead),
              ne(messages.senderId, userId),
            )
          : and(
              eq(messages.roomId, room.roomId),
              ne(messages.senderId, userId),
            );

        const [result] = await db
          .select({ count: count() })
          .from(messages)
          .where(whereClause)
          .limit(1);

        unread[room.slug] = Math.min(result?.count ?? 0, 99);
      }),
    );

    res.json({ unread });
  },
);

// ── Phase 11 D-05: Join a Globe room ──────────────────────────────────────
// Idempotent — re-running with the same (userId, roomSlug) is a no-op via
// onConflictDoNothing. Slug validation via isValidGlobeRoom. No capability
// gate (D-10 — Globe-room membership is not a capability axis). No
// caps:invalidated emit. requireAuth covered at router level (line 12).
router.post(
  '/rooms/:slug/join',
  async (req: AuthRequest, res: Response): Promise<void> => {
    const slug = req.params.slug as string;
    // Phase 15 (D-08, TZRM-01): slug may be a globe-room OR a timezone-room.
    // Globe rooms have no cap gate (CONTEXT §domain bullet 3). Timezone rooms
    // gate on non-native joins only.
    const isGlobe = isValidGlobeRoom(slug);
    const isTimezone = isValidTimezoneRoom(slug);
    if (!isGlobe && !isTimezone) {
      res.status(404).json({ error: 'Unknown room' });
      return;
    }

    const userId = req.user!.id;

    if (isTimezone && !isCallerNativeForSlug(req.user!.timezone ?? 'UTC', slug)) {
      const caps = await getCapabilities(req);
      if (!callerCanAccessNonNativeTimezone(caps)) {
        logCapabilityDenial({
          req,
          capability: 'tzroom:non-native-join',
          currentTier: caps.tier,
          reason: 'feature',
        });
        // High-cardinality console log (capability denial logger emits the
        // structured pino warn; this console.log gives operator quick grep).
        console.log(
          '[tzroom join] userId=' + userId + ' slug=' + slug +
          ' caller-tier=' + caps.tier + ' verdict=denied-non-native-free',
        );
        res.status(403).json({
          error: 'Premium required to join non-native timezone rooms',
          capabilityViolation: true,
        });
        return;
      }
    }

    await db
      .insert(globeRoomMemberships)
      .values({ userId, roomSlug: slug })
      .onConflictDoNothing({
        target: [globeRoomMemberships.userId, globeRoomMemberships.roomSlug],
      });

    if (isTimezone) {
      console.log(
        '[tzroom join] userId=' + userId + ' slug=' + slug + ' verdict=ok',
      );
    }

    res.json({ ok: true, isMember: true });
  },
);

// ── Phase 11 D-05 + D-08: Leave a Globe room ──────────────────────────────
// Slug validation + autoJoin gate. autoJoin=true rooms (Town Square only in
// v1.7) CANNOT be left — returns 422. Regular regional rooms remove the
// membership row but PRESERVE the corresponding globe_read_positions row
// (D-08 — keeps read position on rejoin; cheap to keep). No
// caps:invalidated emit (D-10).
router.delete(
  '/rooms/:slug/join',
  async (req: AuthRequest, res: Response): Promise<void> => {
    const slug = req.params.slug as string;
    // Phase 15: accept globe-room OR timezone-room slugs. Explicit
    // user-initiated DELETE is always honored — D-09's "never delete on
    // downgrade" only applies to the caps:invalidated server-driven path.
    const isGlobe = isValidGlobeRoom(slug);
    const isTimezone = isValidTimezoneRoom(slug);
    if (!isGlobe && !isTimezone) {
      res.status(404).json({ error: 'Unknown room' });
      return;
    }

    // autoJoin gate applies ONLY to globe rooms (Town Square). Timezone
    // rooms have no autoJoin concept and can always be left.
    if (isGlobe) {
      const room = getGlobeRoom(slug);
      if (room?.autoJoin) {
        res.status(422).json({ error: 'Cannot leave an auto-join community' });
        return;
      }
    }

    const userId = req.user!.id;
    await db
      .delete(globeRoomMemberships)
      .where(
        and(
          eq(globeRoomMemberships.userId, userId),
          eq(globeRoomMemberships.roomSlug, slug),
        ),
      );

    res.json({ ok: true, isMember: false });
  },
);

export default router;
