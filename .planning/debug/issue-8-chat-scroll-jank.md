---
status: diagnosed
trigger: "ISSUE-8: Opening a room's chat is jumpy — list renders then scrolls to bottom, visible jank, worse on Android. Reproduced on Town Square."
created: 2026-05-30
updated: 2026-05-30
---

## Current Focus

hypothesis: CONFIRMED — non-inverted FlatList with no getItemLayout relies on a cascade of timed scrollToEnd calls + onContentSizeChange re-snap to reach the bottom after first paint, producing a visible top-to-bottom jump.
next_action: return diagnosis (read-only mode)

## Symptoms

expected: Room chat opens already scrolled to the newest message, no visible movement.
actual: List paints top-anchored (oldest visible), then jumps to bottom after content size is measured; multiple re-snaps over several seconds. Worse on Android.
errors: none
reproduction: Open any globe/timezone/regional room or Town Square chat.
started: pre-existing (architectural)

## Resolution

root_cause: The shared GlobeRoomScreen FlatList is NOT inverted, has NO getItemLayout, NO initialScrollIndex, and NO maintainVisibleContentPosition; it loads 50 chronological messages (newest last) then reaches the bottom only via timed scrollToEnd retries (100/500/1500/3000ms) and a 5s onContentSizeChange re-snap loop, so the list visibly paints top-anchored and then jumps to the bottom once async layout (avatars/reactions/reply previews) settles — worse on Android because windowed item measurement is slower.
fix: Use an inverted FlatList (reverse data, newest first) so the bottom is the natural initial anchor — no scrollToEnd needed on mount.
verification: n/a (diagnose-only)
files_changed: []
