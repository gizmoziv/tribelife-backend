// ── Notification Tab Resolver ──────────────────────────────────────────────
// Canonical backend mapping from notification `type` (varchar) to the bell
// tab that owns it. Pure function — no db import.
//
// NOTE: type:'group' rows (D-14, CPO reversal 2026-05-30) map to 'groups'.
// The Groups count includes both derived unread state AND stored 'group' rows.

/** Bell tab identifiers. */
export type NotificationTab = 'groups' | 'dms' | 'matches' | 'system' | 'org';

/**
 * Map a notification `type` string to its bell tab.
 * Unknown types are bucketed into 'system' (safe default; type is varchar — no DB guard).
 */
export function typeToTab(type: string): NotificationTab {
  switch (type) {
    case 'mention':
      return 'dms';
    case 'new_dm':
      return 'dms';
    case 'beacon_match':
      return 'matches';
    case 'system':
      return 'system';
    case 'org_invite':
      return 'org';
    case 'group':
      return 'groups';
    default:
      return 'system';
  }
}
