import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  varchar,
  jsonb,
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
});

export const conversationParticipants = pgTable('conversation_participants', {
  id: serial('id').primaryKey(),
  conversationId: integer('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }).notNull(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  joinedAt: timestamp('joined_at').defaultNow(),
  lastReadAt: timestamp('last_read_at'),
}, (t) => ({
  uniqPair: unique().on(t.conversationId, t.userId),
  userIdx: index('conv_participants_user_idx').on(t.userId),
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
  embedding: text('embedding'),                     // JSON-serialized float[] for similarity search
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
  similarityScore: text('similarity_score').notNull(),  // stored as string to avoid float precision issues
  matchReason: text('match_reason'),                    // Claude's explanation of why they matched
  notifiedAt: timestamp('notified_at'),
  viewedAt: timestamp('viewed_at'),
  createdAt: timestamp('created_at').defaultNow(),
}, (t) => ({
  beaconIdx: index('beacon_matches_beacon_idx').on(t.beaconId),
  uniqMatch: unique().on(t.beaconId, t.matchedBeaconId),
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
// RELATIONS
// ─────────────────────────────────────────────
export const usersRelations = relations(users, ({ one, many }) => ({
  profile: one(userProfiles, { fields: [users.id], references: [userProfiles.userId] }),
  messages: many(messages),
  beacons: many(beacons),
  notifications: many(notifications),
  conversationParticipants: many(conversationParticipants),
}));

export const userProfilesRelations = relations(userProfiles, ({ one }) => ({
  user: one(users, { fields: [userProfiles.userId], references: [users.id] }),
}));

export const conversationsRelations = relations(conversations, ({ many }) => ({
  participants: many(conversationParticipants),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  sender: one(users, { fields: [messages.senderId], references: [users.id] }),
  conversation: one(conversations, { fields: [messages.conversationId], references: [conversations.id] }),
}));

export const beaconsRelations = relations(beacons, ({ one, many }) => ({
  user: one(users, { fields: [beacons.userId], references: [users.id] }),
  matches: many(beaconMatches, { relationName: 'beaconMatches' }),
}));

export const beaconMatchesRelations = relations(beaconMatches, ({ one }) => ({
  beacon: one(beacons, { fields: [beaconMatches.beaconId], references: [beacons.id], relationName: 'beaconMatches' }),
  matchedBeacon: one(beacons, { fields: [beaconMatches.matchedBeaconId], references: [beacons.id] }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
}));
