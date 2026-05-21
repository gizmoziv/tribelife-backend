// ── Phase 14: Chat Search — SearchResult discriminated union ───────────────
// Response shape for GET /api/chat/search (SRCH-01).
// Discriminator is the `source` string literal — mirrors Phase 10
// ChatNotificationPayload shape exactly so mobile can reuse the
// routeChatNotificationTap-style routing for tap navigation (D-04).
//
// The `entityId` field is the canonical row identity from /api/chats:
//   - dm/group:    entityId = conversationId (number)
//   - globe_room:  entityId = roomSlug        (string, e.g., 'town-square')
//   - local_chat:  entityId = timezoneIana    (string, e.g., 'America/New_York')
//
// MIRROR: tribelife-mobile/types/index.ts — keep in sync (hand-mirrored, no
// shared types package — Phase 10 chatNotification.ts precedent).

export type SearchResult =
  | {
      source: 'dm';
      messageId: number;
      content: string;
      createdAt: string;
      senderHandle: string;
      chatTitle: string;
      entityId: number;
      conversationId: number;
    }
  | {
      source: 'group';
      messageId: number;
      content: string;
      createdAt: string;
      senderHandle: string;
      chatTitle: string;
      entityId: number;
      conversationId: number;
    }
  | {
      source: 'globe_room';
      messageId: number;
      content: string;
      createdAt: string;
      senderHandle: string;
      chatTitle: string;
      entityId: string;
      roomSlug: string;
    }
  | {
      source: 'local_chat';
      messageId: number;
      content: string;
      createdAt: string;
      senderHandle: string;
      chatTitle: string;
      entityId: string;
      timezoneIana: string;
    };

// Paginated search response (D-02: cursor pagination on (createdAt, id)).
export type SearchResponse = {
  results: SearchResult[];
  nextCursor: string | null;
};
