---
status: investigating
trigger: "ISSUE-1 + ISSUE-7: direct chat open clears row dot but not bell count number; live-received-while-focused messages not marked read"
created: 2026-05-30T00:00:00Z
updated: 2026-05-30T00:00:00Z
---

## Current Focus

hypothesis: Direct chat-open path does NOT call PUT /read-context (or calls it without clearing group rows / refetching summary); live messages while focused don't trigger read advancement.
test: Read mobile chat screens + notificationStore + read-context call sites
expecting: Find that bell count is sourced from /summary store, refetched only on bell-tap path, not on direct open
next_action: Read [conversationId].tsx, local.tsx, globe/[roomSlug].tsx, town-square.tsx, notificationStore.ts, notificationRouting.ts, api.ts read-context

## Symptoms

expected: Direct chat open decrements bell group COUNT and marks live-received messages read
actual: Row dot clears but bell count number stays; live messages while focused not auto-read
errors: none
reproduction: Open chat directly from Chats list (not via bell). Bell count stays. Receive message while in chat, leave — bell shows 1.
started: Phase 16 notifications rework

## Eliminated

## Evidence

- timestamp: 2026-05-30T00:00:00Z
  checked: backend notifications.ts read-context handler (lines 386-476)
  found: read-context DOES mark type:'group' rows read by entityId (lines 463-473). So IF mobile calls it, server-side group rows clear and /summary groups count would drop.
  implication: Bug is on mobile — either read-context not called on direct open, or summary not refetched after.

## Resolution

root_cause: read-context's `markedRead` return value excludes the stored type:'group' rows it clears (returns only mention/new_dm ids at line 433/475). Mobile chat screens gate the /summary refetch behind `if (markedRead.length > 0)`, so a plain group/room message (no @-mention) clears the server group row but the client never refetches /summary, leaving the bell count stale. ISSUE-7: read-context runs only once on mount; live messages create new unread group rows server-side (no active-viewer check in fan-out) that are never re-cleared, while _layout's chat:notification handler unconditionally refetches /summary and re-shows the count.
fix: (1) Include the group-row ids in read-context's response so the client knows rows were cleared; OR have the client always refetch /summary after read-context regardless of markedRead.length. (2) Re-call read-context on each incoming socket message while focused (or suppress the _layout summary-refetch when currentlyViewing matches the incoming entityId).
verification: not applied (diagnose-only)
files_changed: []
