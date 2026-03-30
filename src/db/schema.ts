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
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ─────────────────────────────────────────────
// USERS (mirrors + extends webapp users table)
// ─────────────────────────────────────────────
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: text('password_hash'),            // null for Google-only accounts
  name: varchar('name', { length: 255 }).notNull(),
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
});

export const conversationParticipants = pgTable('conversation_participants', {
  id: serial('id').primaryKey(),
  conversationId: integer('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }).notNull(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  joinedAt: timestamp('joined_at').defaultNow(),
  lastReadAt: timestamp('last_read_at'),
  hiddenAt: timestamp('hidden_at'),
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
  replyToId: integer('reply_to_id'),                        // SCHM-01: nullable self-ref FK (added via migration)
  mediaUrls: jsonb('media_urls').$type<string[]>(),         // SCHM-02: nullable JSON array of URLs
  translatedContent: text('translated_content'),
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
  referrerId: integer('referrer_id').notNull().references(() => users.id),
  referredUserId: integer('referred_user_id').references(() => users.id),
  referralCode: varchar('referral_code', { length: 50 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  convertedAt: timestamp('converted_at'),
}, (t) => [
  index('referrals_referrer_idx').on(t.referrerId),
  index('referrals_code_idx').on(t.referralCode),
]);

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
