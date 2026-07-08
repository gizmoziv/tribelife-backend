---
quick_id: 260708-bs3
slug: group-slug-rename-aliases-and-user-audit
date: 2026-07-08
status: complete
committed: false
migration_applied: false
---

# Summary — Group slug-on-rename + aliases, and user audit events

Backend-only. tsc clean. **Not committed** (awaiting user approval). **Migration NOT applied** (live prod DB — human runs it).

## Files changed
- `src/db/schema.ts` — `group_slug_aliases` table, `user_events` table, `user_profiles.last_active_at` column.
- `src/routes/groups.ts` — `slugify` (canonical, returns '' for non-sluggable names) / `isSlugTaken` / `resolveGroupIdBySlug` helpers. **Canonical-slug uniqueness (CPO override):** slug is always `slugify(name)`, any client-supplied slug is IGNORED, and a colliding name is REJECTED (409) instead of suffixed. Empty-slug names → 400. Same rule on create and rename; slug-on-rename still writes the old slug as an alias in a transaction (with A→B→A reclaim); alias fallback on `GET /:slug` and `POST /:slug/join`.
- `src/jobs/aliasReaper.ts` — NEW daily cron (04:00 UTC) reaping aliases unused >30 days.
- `src/server.ts` — wire `startAliasReaperCron` into boot + shutdown `cronTasks`.
- `src/services/userEvents.ts` — NEW `logUserEvent(userId|null, type, metadata?)`, error-swallowing.
- `src/routes/auth.ts` — `login` events on `/google` + `/apple`; `account_deleted` (untethered) on `DELETE /account`.
- `src/routes/upload.ts` — `image_uploaded` events on all four confirm endpoints (avatar / media / group-icon / org-icon).
- `src/socket/index.ts` — throttled `last_active_at` update on connect (≤ once/5min per user).

## Migration
- `drizzle/0034_group_slug_aliases_and_user_events.sql` (generated offline, renamed off `quick_flatman`; journal tag synced).
- Purely additive: 2 CREATE TABLE, 1 ADD COLUMN, 2 FKs, 4 indexes. No DROP INDEX (no trgm drift). Zero-downtime safe.

## Not done (by design / constraint)
- No commit (awaiting approval).
- Migration not applied — human runs it on prod (see APPLY-RUNBOOK.md).
- Logout event intentionally skipped (no backend signal; inactivity via `last_active_at`).

## Mobile follow-ups (created by the canonical-slug decision — separate task)
- **Create screen** (`group/create.tsx`): the editable slug field is now ignored by the backend (slug always follows the name). Remove/disable it, or show the derived slug read-only, so users aren't misled.
- **Rename screen** (`group/[conversationId].tsx` `handleSaveRename`): today it shows a generic `"Could not rename the group."` on any failure. Surface the server's 409 message ("A group with a similar name already exists…") so a rejected rename explains itself.
- **Create error copy**: confirm the create screen surfaces the server 409 message (not just a generic one).

## Not addressed (possible later task)
- Existing prod groups with old random-suffixed slugs keep working; no dedup/backfill of any current duplicate names was done — new rule is forward-only.
