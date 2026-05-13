// ── Phase 10: Notification Consolidation ──────────────────────────────────
// Discriminated payload shape emitted on the `chat:notification` socket event
// AND mirrored verbatim inside the Expo push `data` field (per 10-CONTEXT.md
// D-01 + D-04). Discriminator is the `source` string literal. Backend mirror
// of the mobile `ChatNotification` type Plan 10-02 lands — kept in sync by
// hand (matches Phase 8 CapsInvalidatedReason + Phase 9 ChatsRow precedent;
// no shared types package).
//
// The `entityId` field is the canonical row identity from /api/chats:
//   - DM/group:   entityId = conversationId (number)
//   - globe_room: entityId = roomSlug         (string, e.g., 'town-square')
//   - local_chat: entityId = timezoneIana     (string, e.g., 'America/New_York')
// Lets the mobile tap-router and store-applier share one key path.

export interface ChatNotificationCommon {
  notificationId: number;
  title: string;
  body: string;
  senderHandle: string;
}

export type ChatNotificationPayload =
  | (ChatNotificationCommon & {
      source: 'dm';
      entityId: number;
      conversationId: number;
    })
  | (ChatNotificationCommon & {
      source: 'group';
      entityId: number;
      conversationId: number;
      groupName?: string;
    })
  | (ChatNotificationCommon & {
      source: 'globe_room';
      entityId: string;
      roomSlug: string;
    })
  | (ChatNotificationCommon & {
      source: 'local_chat';
      entityId: string;
      timezoneIana: string;
    });

// The push `data` field shape — same as ChatNotificationPayload PLUS the
// top-level `type: 'chat'` discriminator the OS-level tap handler in
// _layout.tsx branches on (per 10-CONTEXT.md D-04). title/body live in the
// push notification body itself; the `data` field carries identity + routing.
export type ChatPushData = ChatNotificationPayload & { type: 'chat' };
