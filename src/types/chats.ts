// ── Phase 9: Chats Tab Restructure ─────────────────────────────────────────
// Discriminated-union row shape returned by GET /api/chats. Server owns the
// ordering: rows[0] is always the local_chat row (the user's timezone room),
// rows[1] is always the town_square row, and the rest are DMs/Groups sorted
// by unreadCount DESC, lastMessageAt DESC (per CONTEXT.md D-01).
//
// The local_chat variant carries TWO slugs: `roomSlug: 'local'` is the
// constant discriminator the mobile client uses to identify the row at
// render time; `timezoneIana` is the actual IANA timezone string (e.g.,
// "America/New_York") used for (a) rendering a friendly zone-name label
// and (b) calling POST /api/chats/room-read when the user reads Local Chat.
//
// The town_square variant has only the constant `roomSlug: 'town-square'`.

export interface ChatsRowLastMessage {
  preview: string;
  at: string;     // ISO 8601 timestamp (JSON-serialized Date)
}

export type ChatsRow =
  | {
      type: 'local_chat';
      roomSlug: 'local';
      timezoneIana: string;
      unreadCount: number;
      lastMessage: ChatsRowLastMessage | null;
    }
  | {
      type: 'town_square';
      roomSlug: 'town-square';
      unreadCount: number;
      lastMessage: ChatsRowLastMessage | null;
    }
  | {
      type: 'dm';
      conversationId: number;
      partner: { handle: string; avatarUrl: string | null };
      unreadCount: number;
      lastMessage: ChatsRowLastMessage | null;
    }
  | {
      type: 'group';
      conversationId: number;
      name: string;
      iconUrl: string | null;
      memberCount: number;
      unreadCount: number;
      lastMessage: ChatsRowLastMessage | null;
    };

export interface ChatsListResponse {
  rows: ChatsRow[];
}
