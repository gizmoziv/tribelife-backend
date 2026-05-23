// ── Phase 15 Plan 04 (TZRM-02, D-10): Chevra Discovery Row Types ────────────
// Backend ChevraRow discriminated union — the response shape of
// GET /api/globe/rooms. Hand-mirrored to `tribelife-mobile/types/index.ts`
// (no shared types package — Phase 10 / Phase 12 precedent).
//
// History:
//   - Phase 11 introduced the globe_room variant.
//   - Phase 12 added the group variant for public-group discovery.
//   - Phase 15 Plan 04 adds the timezone_room variant for the paywalled
//     non-native timezone discovery surface (D-10 + TZRM-02).

export type ChevraRow =
  | {
      kind: 'globe_room';
      slug: string;
      displayName: string;
      participantCount: number;
      lastMessage: { content: string; createdAt: string | Date | null; senderHandle: string | null } | null;
      isSuggested: boolean;
      isGlobal: boolean;
      sortOrder: number;
      welcomeMessage: string;
      isMember: boolean;
      autoJoin: boolean;
    }
  | {
      kind: 'group';
      conversationId: number;
      name: string;
      iconUrl: string | null;
      inviteSlug: string;
      memberCount: number;
      lastMessage: { content: string; createdAt: string; senderHandle: string } | null;
      isMember: boolean;
    }
  // Phase 15 D-10 + TZRM-02: discovery surface for timezone rooms — paywall
  // flag for free callers, isMember for joined non-native filter on premium.
  | {
      kind: 'timezone_room';
      slug: string;
      displayName: string;
      memberCount: number;
      lastMessage: { content: string; createdAt: string; senderHandle: string } | null;
      isMember: boolean;
      paywalled: boolean;
    };

export interface ChevraListResponse {
  rooms: ChevraRow[];
}
