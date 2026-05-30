// ── Notification Tab Resolver ──────────────────────────────────────────────
// Canonical backend mapping from notification `type` (varchar) to the bell
// tab that owns it. Pure function — no db import.
//
// NOTE: 'groups' is DERIVED (no stored notification type maps to it).
// The Groups count comes from the /summary derived query (routes/notifications.ts).
// This resolver never returns 'groups'.

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
    default:
      return 'system';
  }
}
