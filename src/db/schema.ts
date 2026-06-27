import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  varchar,
  jsonb,
  numeric,
  unique,
  index,
  uniqueIndex,
  check,
  pgEnum,
  doublePrecision,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// ─────────────────────────────────────────────
// USERS (mirrors + extends webapp users table)
// ─────────────────────────────────────────────
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: text('password_hash'),            // null for Google-only accounts
  name: varchar('name', { length: 255 }).notNull(),
  bannedAt: timestamp('banned_at'),               // platform ban: non-null = suspended (blocks sign-in + kills live sessions)
  banReason: text('ban_reason'),                  // optional admin note for the ban
  isStaff: boolean('is_staff').notNull().default(false), // global staff flag — grants pin rights in community rooms (D-03, D-06)
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Extended profile — one per user, created on mobile onboarding
export const userProfiles = pgTable('user_profiles', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull().unique(),
  handle: varchar('handle', { length: 50 }).notNull().unique(),  // @handle
  avatarUrl: text('avatar_url'),
  timezone: varchar('timezone', { length: 100 }),                // e.g. "America/New_York"
  googleId: text('google_id').unique(),                          // from Google OAuth
  appleId: text('apple_id').unique(),                            // from Sign in with Apple
  isPremium: boolean('is_premium').notNull().default(false),
  premiumExpiresAt: timestamp('premium_expires_at'),
  revenuecatCustomerId: text('revenuecat_customer_id'),
  expoPushToken: text('expo_push_token'),                        // for push notifications
  newsPushEnabled: boolean('news_push_enabled').notNull().default(true),
  acceptedTermsAt: timestamp('accepted_terms_at'),               // null = onboarding not complete
  handleUpdatedAt: timestamp('handle_updated_at'),               // null = handle never changed since onboarding (no cooldown active)
  bio: text('bio'),
  // ── Candle-lighting location (TRIBE-06) — all nullable, additive ──────────
  candleGeonameid: integer('candle_geonameid'),                    // GeoNames city id (manual pick)
  candleLat: doublePrecision('candle_lat'),                        // coarse GPS latitude
  candleLon: doublePrecision('candle_lon'),                        // coarse GPS longitude
  candleLabel: text('candle_label'),                               // display name of chosen city
  candleSource: varchar('candle_source', { length: 10 }),          // 'manual' | 'gps'
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (t) => ({
  handleIdx: index('user_profiles_handle_idx').on(t.handle),
  timezoneIdx: index('user_profiles_timezone_idx').on(t.timezone),
}));

// ─────────────────────────────────────────────
// CHAT — Conversations (1-on-1 DMs)
// ─────────────────────────────────────────────
export const conversations = pgTable('conversations', {
  id: serial('id').primaryKey(),
  createdAt: timestamp('created_at').defaultNow(),
  lastMessageAt: timestamp('last_message_at').defaultNow(),
  isGroup: boolean('is_group'),                             // SCHM-04: nullable, null = legacy 1:1 DM
  groupName: varchar('group_name', { length: 100 }),        // SCHM-04: nullable, only set for groups
  createdById: integer('created_by_id').references(() => users.id, { onDelete: 'set null' }),
  groupIconUrl: text('group_icon_url'),
  inviteSlug: varchar('invite_slug', { length: 50 }).unique(),
  maxMembers: integer('max_members').default(200),
  // Phase 12 D-01: public/archive flags for group discovery + last-admin auto-archive
  isPublic: boolean('is_public').notNull().default(false),
  archivedAt: timestamp('archived_at'),
}, (t) => ({
  publicActiveIdx: index('conversations_public_active_idx')
    .on(t.isPublic, t.archivedAt)
    .where(sql`${t.isGroup} = true`),
}));

export const conversationParticipants = pgTable('conversation_participants', {
  id: serial('id').primaryKey(),
  conversationId: integer('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }).notNull(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  joinedAt: timestamp('joined_at').defaultNow(),
  lastReadAt: timestamp('last_read_at'),
  hiddenAt: timestamp('hidden_at'),
  archivedAt: timestamp('archived_at'),
  mutedAt: timestamp('muted_at'),                            // null = not muted; a timestamp = muted-since (MUTE-02)
  role: varchar('role', { length: 20 }).default('member'),
  leftAt: timestamp('left_at'),
}, (t) => ({
  uniqPair: unique().on(t.conversationId, t.userId),
  userIdx: index('conv_participants_user_idx').on(t.userId),
}));

// ─────────────────────────────────────────────
// GLOBE — Read position tracking for unread badges
// ─────────────────────────────────────────────
export const globeReadPositions = pgTable('globe_read_positions', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  roomSlug: varchar('room_slug', { length: 100 }).notNull(),
  lastReadAt: timestamp('last_read_at').notNull().defaultNow(),
}, (t) => ({
  uniqUserRoom: unique().on(t.userId, t.roomSlug),
  userIdx: index('globe_read_positions_user_idx').on(t.userId),
}));

// ─────────────────────────────────────────────
// GLOBE — Room memberships (Phase 7, D-01)
// ─────────────────────────────────────────────
export const globeRoomMemberships = pgTable('globe_room_memberships', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  roomSlug: varchar('room_slug', { length: 100 }).notNull(),
  joinedAt: timestamp('joined_at').defaultNow(),
}, (t) => ({
  uniqUserRoom: unique().on(t.userId, t.roomSlug),
  userIdx: index('globe_room_memberships_user_idx').on(t.userId),
  roomSlugIdx: index('globe_room_memberships_room_slug_idx').on(t.roomSlug),
}));

// ─────────────────────────────────────────────
// CHAT — Messages (both location-based rooms and DMs)
// ─────────────────────────────────────────────
export const messages = pgTable('messages', {
  id: serial('id').primaryKey(),
  content: text('content').notNull(),
  senderId: integer('sender_id').references(() => users.id, { onDelete: 'set null' }),

  // One of these will be set (room-based OR direct)
  roomId: varchar('room_id', { length: 100 }),         // e.g. "timezone:America/New_York"
  conversationId: integer('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }),

  // Mentions: array of userId strings parsed from @handle mentions
  mentions: jsonb('mentions').$type<number[]>().default([]),

  createdAt: timestamp('created_at').defaultNow(),
  deletedAt: timestamp('deleted_at'),
  editedAt: timestamp('edited_at'),                         // null = never edited; set on first edit via PATCH /api/chat/messages/:id
  replyToId: integer('reply_to_id'),                        // SCHM-01: nullable self-ref FK (added via migration)
  mediaUrls: jsonb('media_urls').$type<string[]>(),         // SCHM-02: nullable JSON array of URLs
  translatedContent: text('translated_content'),
  kind: varchar('kind', { length: 20 }).default('user'),    // 'user' | 'system' (e.g. join announcement)
  // ── Voice message columns (Phase 25, D-13) — all nullable, additive ──────────
  voiceUrl: text('voice_url'),                                          // DO Spaces URL for voice audio (never stored in mediaUrls)
  voiceDurationMs: integer('voice_duration_ms'),                        // duration in milliseconds
  voiceWaveform: jsonb('voice_waveform').$type<number[]>(),             // amplitude peaks array (precomputed client-side)
  voiceTranscript: text('voice_transcript'),                            // Whisper transcript cache (instant reveal, D-13)
}, (t) => ({
  roomIdx: index('messages_room_idx').on(t.roomId),
  convIdx: index('messages_conv_idx').on(t.conversationId),
  senderIdx: index('messages_sender_idx').on(t.senderId),
  createdAtIdx: index('messages_created_at_idx').on(t.createdAt),
}));

// ─────────────────────────────────────────────
// BEACONS
// ─────────────────────────────────────────────
export const beacons = pgTable('beacons', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  rawText: text('raw_text').notNull(),              // original user input
  parsedIntent: text('parsed_intent'),              // Claude-extracted normalized intent
  keywords: text('keywords'),                        // renamed from embedding (D-11)
  timezone: varchar('timezone', { length: 100 }),  // denormalized from profile at creation time
  isActive: boolean('is_active').notNull().default(true),
  isSanitized: boolean('is_sanitized').notNull().default(false),  // passed moderation
  lastMatchedAt: timestamp('last_matched_at'),
  expiresAt: timestamp('expires_at'),               // beacons auto-expire after 30 days
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (t) => ({
  userIdx: index('beacons_user_idx').on(t.userId),
  timezoneIdx: index('beacons_timezone_idx').on(t.timezone),
  activeIdx: index('beacons_active_idx').on(t.isActive),
}));

export const beaconMatches = pgTable('beacon_matches', {
  id: serial('id').primaryKey(),
  beaconId: integer('beacon_id').references(() => beacons.id, { onDelete: 'cascade' }).notNull(),
  matchedBeaconId: integer('matched_beacon_id').references(() => beacons.id, { onDelete: 'cascade' }).notNull(),
  similarityScore: numeric('similarity_score').notNull(),  // changed from text to numeric (D-11)
  matchReason: text('match_reason'),                    // Claude's explanation of why they matched
  notifiedAt: timestamp('notified_at'),
  viewedAt: timestamp('viewed_at'),
  dismissedAt: timestamp('dismissed_at'),
  createdAt: timestamp('created_at').defaultNow(),
}, (t) => ({
  beaconIdx: index('beacon_matches_beacon_idx').on(t.beaconId),
  uniqMatch: unique().on(t.beaconId, t.matchedBeaconId),
}));

// ─────────────────────────────────────────────
// REACTIONS
// ─────────────────────────────────────────────
export const reactions = pgTable('reactions', {
  id: serial('id').primaryKey(),
  messageId: integer('message_id').references(() => messages.id, { onDelete: 'cascade' }).notNull(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  emoji: varchar('emoji', { length: 20 }).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
}, (t) => ({
  msgIdx: index('reactions_message_idx').on(t.messageId),
  uniqReaction: unique().on(t.messageId, t.userId, t.emoji),
}));

// ─────────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────────
export const notifications = pgTable('notifications', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  type: varchar('type', { length: 50 }).notNull(),
  // types: 'mention' | 'beacon_match' | 'new_dm' | 'system'
  title: varchar('title', { length: 255 }).notNull(),
  body: text('body').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>().default({}),
  // data payload varies by type:
  // mention: { messageId, roomId | conversationId, senderHandle }
  // beacon_match: { beaconMatchId, beaconId, matchedUserId }
  // new_dm: { conversationId, senderHandle }
  isRead: boolean('is_read').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow(),
}, (t) => ({
  userIdx: index('notifications_user_idx').on(t.userId),
  unreadIdx: index('notifications_unread_idx').on(t.userId, t.isRead),
}));

// ─────────────────────────────────────────────
// NOTIFICATION PREFERENCES
// ─────────────────────────────────────────────
export const notificationPreferences = pgTable('notification_preferences', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull().unique(),
  mentionsPush: boolean('mentions_push').notNull().default(true),
  timezoneChatPush: boolean('timezone_chat_push').notNull().default(true),
  beaconMatchesPush: boolean('beacon_matches_push').notNull().default(true),
  dmPush: boolean('dm_push').notNull().default(true),
  townSquarePush: boolean('town_square_push').notNull().default(true),
  dmsPush: boolean('dms_push').notNull().default(true),
  groupsPush: boolean('groups_push').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const notificationPreferencesRelations = relations(notificationPreferences, ({ one }) => ({
  user: one(users, { fields: [notificationPreferences.userId], references: [users.id] }),
}));

// ─────────────────────────────────────────────
// ANDROID WAITLIST
// ─────────────────────────────────────────────
export const androidWaitlist = pgTable('android_waitlist', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  createdAt: timestamp('created_at').defaultNow(),
});

// ─────────────────────────────────────────────
// MODERATION
// ─────────────────────────────────────────────
export const blockedUsers = pgTable('blocked_users', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  blockedUserId: integer('blocked_user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
}, (t) => ({
  uniqBlock: unique().on(t.userId, t.blockedUserId),
}));

export const contentReports = pgTable('content_reports', {
  id: serial('id').primaryKey(),
  reporterId: integer('reporter_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  reportedUserId: integer('reported_user_id').references(() => users.id, { onDelete: 'set null' }),
  contentType: varchar('content_type', { length: 50 }).notNull(),  // 'message' | 'beacon' | 'profile'
  contentId: integer('content_id'),
  reason: text('reason').notNull(),
  status: varchar('status', { length: 50 }).notNull().default('pending'),  // 'pending' | 'reviewed' | 'actioned'
  createdAt: timestamp('created_at').defaultNow(),
  reviewedAt: timestamp('reviewed_at'),
});

// ─────────────────────────────────────────────
// REFERRALS
// ─────────────────────────────────────────────
export const referrals = pgTable('referrals', {
  id: serial('id').primaryKey(),
  referrerId: integer('referrer_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  referredUserId: integer('referred_user_id').references(() => users.id, { onDelete: 'cascade' }),
  referralCode: varchar('referral_code', { length: 50 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  source: varchar('source', { length: 20 }).notNull().default('handle_code'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  convertedAt: timestamp('converted_at'),
}, (t) => [
  index('referrals_referrer_idx').on(t.referrerId),
  index('referrals_code_idx').on(t.referralCode),
]);

// ─────────────────────────────────────────────
// ATTRIBUTION CONVERSIONS (Phase 13)
// Paid-conversion records — webhook-driven, copies first-touch referrer
// ─────────────────────────────────────────────
export const attributionConversions = pgTable('attribution_conversions', {
  id: serial('id').primaryKey(),
  referredUserId: integer('referred_user_id').references(() => users.id, { onDelete: 'set null' }),
  referrerUserId: integer('referrer_user_id').references(() => users.id, { onDelete: 'set null' }),
  source: varchar('source', { length: 20 }).notNull(),
  plan: varchar('plan', { length: 50 }),
  occurredAt: timestamp('occurred_at').notNull().defaultNow(),
  revenuecatEventId: text('revenuecat_event_id'),
}, (t) => [
  index('attribution_conversions_referrer_idx').on(t.referrerUserId, t.occurredAt),
  uniqueIndex('attribution_conversions_event_id_idx').on(t.revenuecatEventId),
]);

// ─────────────────────────────────────────────
// ORGANIZATIONS
// ─────────────────────────────────────────────
export const organizations = pgTable('organizations', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  type: text('type').$type<'jcc' | 'non_profit' | 'creator' | 'community' | 'business'>().notNull(),
  iconUrl: text('icon_url'),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  deletedAt: timestamp('deleted_at'),
}, (table) => ({
  typeIdx: index('organizations_type_idx').on(table.type),
  createdByIdx: index('organizations_created_by_idx').on(table.createdBy),
  typeCheck: check(
    'organizations_type_check',
    sql`${table.type} IN ('jcc', 'non_profit', 'creator', 'community', 'business')`,
  ),
}));

export const organizationMemberships = pgTable('organization_memberships', {
  id: serial('id').primaryKey(),
  orgId: integer('org_id').references(() => organizations.id, { onDelete: 'cascade' }).notNull(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  role: text('role').$type<'admin' | 'moderator' | 'member'>().notNull(),
  joinedAt: timestamp('joined_at').defaultNow().notNull(),
}, (table) => ({
  orgUserUnique: uniqueIndex('organization_memberships_org_user_unique').on(table.orgId, table.userId),
  userIdx: index('organization_memberships_user_idx').on(table.userId),
  orgRoleIdx: index('organization_memberships_org_role_idx').on(table.orgId, table.role),
  roleCheck: check(
    'organization_memberships_role_check',
    sql`${table.role} IN ('admin', 'moderator', 'member')`,
  ),
}));

export const organizationInvites = pgTable('organization_invites', {
  id: serial('id').primaryKey(),
  orgId: integer('org_id').references(() => organizations.id, { onDelete: 'cascade' }).notNull(),
  inviterId: integer('inviter_id').references(() => users.id, { onDelete: 'set null' }),
  invitedUserId: integer('invited_user_id').references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  role: text('role').$type<'admin' | 'moderator' | 'member'>().default('member').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  acceptedAt: timestamp('accepted_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  orgInvitedIdx: index('organization_invites_org_invited_idx').on(table.orgId, table.invitedUserId),
  roleCheck: check(
    'organization_invites_role_check',
    sql`${table.role} IN ('admin', 'moderator', 'member')`,
  ),
}));

// ─────────────────────────────────────────────
// PINNED MESSAGES — one pin per room/conversation (Phase 22)
// XOR: exactly one of roomId / conversationId is non-null, mirroring messages.
// Partial unique indexes enforce ONE pin per room (D-08): a new pin upserts
// (onConflictDoUpdate) to replace the previous one atomically.
// ─────────────────────────────────────────────
export const pinnedMessages = pgTable('pinned_messages', {
  id: serial('id').primaryKey(),
  // XOR: exactly one non-null — mirrors messages.roomId / messages.conversationId
  roomId: varchar('room_id', { length: 100 }),
  conversationId: integer('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }),
  messageId: integer('message_id').references(() => messages.id, { onDelete: 'cascade' }).notNull(),
  pinnedById: integer('pinned_by_id').references(() => users.id, { onDelete: 'set null' }),
  pinnedAt: timestamp('pinned_at').defaultNow().notNull(),
  // Denormalized preview — avoids JOIN on every bar render (Q3)
  previewText: text('preview_text'),
  pinnedMediaUrl: text('pinned_media_url'),
  pinnedSenderHandle: varchar('pinned_sender_handle', { length: 50 }),
}, (t) => ({
  // Enforces exactly ONE pin per room (D-08): partial unique indexes allow upsert targeting
  roomUniq: uniqueIndex('pinned_messages_room_uniq').on(t.roomId).where(sql`${t.roomId} IS NOT NULL`),
  convUniq: uniqueIndex('pinned_messages_conv_uniq').on(t.conversationId).where(sql`${t.conversationId} IS NOT NULL`),
  // Fast lookup of "current pin for this room/convo"
  roomIdx: index('pinned_messages_room_idx').on(t.roomId),
  convIdx: index('pinned_messages_conv_idx').on(t.conversationId),
}));

export const pinnedMessagesRelations = relations(pinnedMessages, ({ one }) => ({
  message: one(messages, { fields: [pinnedMessages.messageId], references: [messages.id] }),
  conversation: one(conversations, { fields: [pinnedMessages.conversationId], references: [conversations.id] }),
  pinnedBy: one(users, { fields: [pinnedMessages.pinnedById], references: [users.id] }),
}));

// ─────────────────────────────────────────────
// RELATIONS
// ─────────────────────────────────────────────
export const usersRelations = relations(users, ({ one, many }) => ({
  profile: one(userProfiles, { fields: [users.id], references: [userProfiles.userId] }),
  messages: many(messages),
  beacons: many(beacons),
  notifications: many(notifications),
  conversationParticipants: many(conversationParticipants),
  blocksInitiated: many(blockedUsers, { relationName: 'blocksInitiated' }),
  blocksReceived: many(blockedUsers, { relationName: 'blocksReceived' }),
  reportsSubmitted: many(contentReports, { relationName: 'reportsSubmitted' }),
  reportsReceived: many(contentReports, { relationName: 'reportsReceived' }),
  globeReadPositions: many(globeReadPositions),
  globeRoomMemberships: many(globeRoomMemberships),
  notificationPreferences: one(notificationPreferences, { fields: [users.id], references: [notificationPreferences.userId] }),
}));

export const userProfilesRelations = relations(userProfiles, ({ one }) => ({
  user: one(users, { fields: [userProfiles.userId], references: [users.id] }),
}));

export const conversationsRelations = relations(conversations, ({ many }) => ({
  participants: many(conversationParticipants),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  sender: one(users, { fields: [messages.senderId], references: [users.id] }),
  conversation: one(conversations, { fields: [messages.conversationId], references: [conversations.id] }),
  replyTo: one(messages, { fields: [messages.replyToId], references: [messages.id], relationName: 'replies' }),
  reactions: many(reactions),
  edits: many(messageEdits),
}));

// ─────────────────────────────────────────────
// MESSAGE EDITS — audit table (tamper-evident history)
// ─────────────────────────────────────────────
export const messageEdits = pgTable('message_edits', {
  id: serial('id').primaryKey(),
  messageId: integer('message_id').references(() => messages.id, { onDelete: 'cascade' }).notNull(),
  content: text('content').notNull(),
  editedAt: timestamp('edited_at').notNull(),
}, (t) => ({
  messageIdx: index('message_edits_message_idx').on(t.messageId),
}));

export const messageEditsRelations = relations(messageEdits, ({ one }) => ({
  message: one(messages, { fields: [messageEdits.messageId], references: [messages.id] }),
}));

export const beaconsRelations = relations(beacons, ({ one, many }) => ({
  user: one(users, { fields: [beacons.userId], references: [users.id] }),
  matches: many(beaconMatches, { relationName: 'beaconMatches' }),
}));

export const beaconMatchesRelations = relations(beaconMatches, ({ one }) => ({
  beacon: one(beacons, { fields: [beaconMatches.beaconId], references: [beacons.id], relationName: 'beaconMatches' }),
  matchedBeacon: one(beacons, { fields: [beaconMatches.matchedBeaconId], references: [beacons.id] }),
}));

export const reactionsRelations = relations(reactions, ({ one }) => ({
  message: one(messages, { fields: [reactions.messageId], references: [messages.id] }),
  user: one(users, { fields: [reactions.userId], references: [users.id] }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
}));

export const blockedUsersRelations = relations(blockedUsers, ({ one }) => ({
  user: one(users, { fields: [blockedUsers.userId], references: [users.id], relationName: 'blocksInitiated' }),
  blockedUser: one(users, { fields: [blockedUsers.blockedUserId], references: [users.id], relationName: 'blocksReceived' }),
}));

export const contentReportsRelations = relations(contentReports, ({ one }) => ({
  reporter: one(users, { fields: [contentReports.reporterId], references: [users.id], relationName: 'reportsSubmitted' }),
  reportedUser: one(users, { fields: [contentReports.reportedUserId], references: [users.id], relationName: 'reportsReceived' }),
}));

export const globeReadPositionsRelations = relations(globeReadPositions, ({ one }) => ({
  user: one(users, { fields: [globeReadPositions.userId], references: [users.id] }),
}));

export const globeRoomMembershipsRelations = relations(globeRoomMemberships, ({ one }) => ({
  user: one(users, { fields: [globeRoomMemberships.userId], references: [users.id] }),
}));

// ─────────────────────────────────────────────
// NEWS — Outlets, Articles, Reactions, Push History, Config (Phase 1 Sprint 4)
// ─────────────────────────────────────────────

// Enum for article importance (Phase 2 populates; Phase 1 leaves NULL)
export const newsImportanceEnum = pgEnum('news_importance', ['breaking', 'major', 'routine']);

// Enum for ingest method (supersedes original INGEST-03 "scrape-only"; D-03 dropped scraping)
export const newsIngestMethodEnum = pgEnum('news_ingest_method', ['rss', 'world_news_api']);

export const newsOutlets = pgTable('news_outlets', {
  id: serial('id').primaryKey(),
  slug: varchar('slug', { length: 50 }).notNull().unique(),
  name: varchar('name', { length: 100 }).notNull(),
  feedUrl: text('feed_url').notNull(),
  breakingFeedUrl: text('breaking_feed_url'),          // INGEST-06: optional priority feed
  politicalLean: varchar('political_lean', { length: 20 }).notNull(),
  ingestMethod: newsIngestMethodEnum('ingest_method').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (t) => ({
  enabledIdx: index('news_outlets_enabled_idx').on(t.enabled),
}));

export const newsArticles = pgTable('news_articles', {
  id: serial('id').primaryKey(),
  outletId: integer('outlet_id').references(() => newsOutlets.id, { onDelete: 'cascade' }).notNull(),

  // D-05 core fields
  title: text('title').notNull(),
  sourceUrl: text('source_url').notNull(),
  urlHash: varchar('url_hash', { length: 64 }).notNull().unique(),  // D-07 SHA-256 hex
  publishedAt: timestamp('published_at').notNull(),
  imageUrl: text('image_url'),
  summary: text('summary'),
  author: varchar('author', { length: 255 }),

  // D-06 Phase 2 placeholder columns (all nullable)
  rephrasedTitle: text('rephrased_title'),
  importance: newsImportanceEnum('importance'),
  originalLanguage: varchar('original_language', { length: 10 }),
  translatedTitle: text('translated_title'),

  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  publishedAtIdx: index('news_articles_published_at_idx').on(t.publishedAt),
  outletIdx: index('news_articles_outlet_idx').on(t.outletId),
  importanceIdx: index('news_articles_importance_idx').on(t.importance),
}));

export const newsReactions = pgTable('news_reactions', {
  id: serial('id').primaryKey(),
  articleId: integer('article_id').references(() => newsArticles.id, { onDelete: 'cascade' }).notNull(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  emoji: varchar('emoji', { length: 20 }).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
}, (t) => ({
  articleIdx: index('news_reactions_article_idx').on(t.articleId),
  uniqReaction: unique().on(t.articleId, t.userId, t.emoji),
}));

export const newsPushHistory = pgTable('news_push_history', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  articleId: integer('article_id').references(() => newsArticles.id, { onDelete: 'cascade' }).notNull(),
  sentAt: timestamp('sent_at').notNull().defaultNow(),
}, (t) => ({
  userSentIdx: index('news_push_history_user_sent_idx').on(t.userId, t.sentAt),
  uniqPush: unique().on(t.userId, t.articleId),
}));

export const newsConfig = pgTable('news_config', {
  key: varchar('key', { length: 100 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// ─────────────────────────────────────────────
// SURVEY — Tables
// ─────────────────────────────────────────────
export const surveys = pgTable('surveys', {
  id: serial('id').primaryKey(),
  questionText: text('question_text').notNull(),
  active: boolean('active').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow(),
}, (t) => ({
  activeIdx: index('surveys_active_idx').on(t.active),
}));

export const surveyOptions = pgTable('survey_options', {
  id: serial('id').primaryKey(),
  surveyId: integer('survey_id').references(() => surveys.id, { onDelete: 'cascade' }).notNull(),
  label: text('label').notNull(),
  isOther: boolean('is_other').notNull().default(false),
  displayOrder: integer('display_order').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
}, (t) => ({
  surveyIdx: index('survey_options_survey_idx').on(t.surveyId),
}));

export const surveyVotes = pgTable('survey_votes', {
  id: serial('id').primaryKey(),
  surveyId: integer('survey_id').references(() => surveys.id, { onDelete: 'cascade' }).notNull(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  optionId: integer('option_id').references(() => surveyOptions.id, { onDelete: 'cascade' }).notNull(),
  otherText: text('other_text'),
  createdAt: timestamp('created_at').defaultNow(),
}, (t) => ({
  surveyIdx: index('survey_votes_survey_idx').on(t.surveyId),
  optionIdx: index('survey_votes_option_idx').on(t.optionId),
  uniqSurveyUserOption: unique('survey_votes_survey_user_option_unique').on(t.surveyId, t.userId, t.optionId),
}));

// ─────────────────────────────────────────────
// SURVEY — Relations
// ─────────────────────────────────────────────
export const surveysRelations = relations(surveys, ({ many }) => ({
  options: many(surveyOptions),
  votes: many(surveyVotes),
}));

export const surveyOptionsRelations = relations(surveyOptions, ({ one }) => ({
  survey: one(surveys, { fields: [surveyOptions.surveyId], references: [surveys.id] }),
}));

export const surveyVotesRelations = relations(surveyVotes, ({ one }) => ({
  survey: one(surveys, { fields: [surveyVotes.surveyId], references: [surveys.id] }),
  option: one(surveyOptions, { fields: [surveyVotes.optionId], references: [surveyOptions.id] }),
  user: one(users, { fields: [surveyVotes.userId], references: [users.id] }),
}));

// ─────────────────────────────────────────────
// NEWS — Relations
// ─────────────────────────────────────────────
export const newsOutletsRelations = relations(newsOutlets, ({ many }) => ({
  articles: many(newsArticles),
}));

export const newsArticlesRelations = relations(newsArticles, ({ one, many }) => ({
  outlet: one(newsOutlets, { fields: [newsArticles.outletId], references: [newsOutlets.id] }),
  reactions: many(newsReactions),
  pushHistory: many(newsPushHistory),
}));

export const newsReactionsRelations = relations(newsReactions, ({ one }) => ({
  article: one(newsArticles, { fields: [newsReactions.articleId], references: [newsArticles.id] }),
  user: one(users, { fields: [newsReactions.userId], references: [users.id] }),
}));

export const newsPushHistoryRelations = relations(newsPushHistory, ({ one }) => ({
  user: one(users, { fields: [newsPushHistory.userId], references: [users.id] }),
  article: one(newsArticles, { fields: [newsPushHistory.articleId], references: [newsArticles.id] }),
}));

// ─────────────────────────────────────────────
// ORGANIZATION — Relations
// ─────────────────────────────────────────────
export const organizationsRelations = relations(organizations, ({ one, many }) => ({
  creator: one(users, {
    fields: [organizations.createdBy],
    references: [users.id],
  }),
  memberships: many(organizationMemberships),
  invites: many(organizationInvites),
}));

export const organizationMembershipsRelations = relations(organizationMemberships, ({ one }) => ({
  organization: one(organizations, {
    fields: [organizationMemberships.orgId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [organizationMemberships.userId],
    references: [users.id],
  }),
}));

export const organizationInvitesRelations = relations(organizationInvites, ({ one }) => ({
  organization: one(organizations, {
    fields: [organizationInvites.orgId],
    references: [organizations.id],
  }),
  inviter: one(users, {
    fields: [organizationInvites.inviterId],
    references: [users.id],
  }),
  invitedUser: one(users, {
    fields: [organizationInvites.invitedUserId],
    references: [users.id],
  }),
}));

// ── Phase 24: Job Postings ────────────────────────────────────────────────────
export const jobPostings = pgTable('job_postings', {
  id:          serial('id').primaryKey(),
  source:      varchar('source', { length: 50 }).notNull(),         // 'jewishjobs' in v1
  externalRef: varchar('external_ref', { length: 100 }).notNull(),  // short stable job id (first URL path segment), e.g. "fhkyf2"
  title:       text('title').notNull(),
  company:     varchar('company', { length: 255 }).notNull(),
  location:    text('location'),                                    // null → mobile renders "Remote"
  postedDate:  varchar('posted_date', { length: 20 }),             // MM/DD/YYYY as scraped
  description: text('description'),                                // abstract, nullable
  logoUrl:     text('logo_url'),                                   // nullable
  viewCount:   integer('view_count').notNull().default(0),
  jobUrl:      text('job_url').notNull(),
  createdAt:   timestamp('created_at').notNull().defaultNow(),     // immutable — first seen
  updatedAt:   timestamp('updated_at').notNull().defaultNow(),     // refreshed on re-scrape
}, (t) => ({
  sourceExtRefUniq: unique().on(t.source, t.externalRef),          // dedup key for upsert
  viewCountIdx:     index('job_postings_view_count_idx').on(t.viewCount),
  postedDateIdx:    index('job_postings_posted_date_idx').on(t.postedDate),
}));
