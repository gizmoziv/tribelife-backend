---
quick_id: 260708-bs3
slug: group-slug-rename-aliases-and-user-audit
date: 2026-07-08
status: in-progress
---

# Quick Task: Group slug-on-rename + old-slug aliases, and user audit events

Backend-only. Extends the existing Express + Socket.IO + Drizzle stack. **Live prod DB — additive only; migrations are generated offline and handed to a human to apply. No DB connection from this session.**

## Feature 1 — Slug follows the rename, with old-slug aliases

**Problem:** Renaming a group updates `group_name` but never `invite_slug`, so invites keep showing the stale slug (`miami-tennis` after "Miami Tennis" → "Tennis").

**Locked decisions:**
- Slug-unique-only. Names stay free-form (NO unique constraint on `group_name`).
- On rename, re-derive slug from the new name; clean if free, `-<rand4>` suffix on collision. **Never block a rename.**
- Old slug is preserved in an alias table that **reserves** the slug (a new group can't grab it while the alias is live).
- 30-day TTL: a daily reaper deletes aliases whose `last_used_at` is older than 30 days, freeing the slug.

**Changes:**
1. `db/schema.ts` — new `group_slug_aliases (id, slug varchar(50) UNIQUE, conversation_id → conversations.id ON DELETE CASCADE, created_at, last_used_at)` + indexes on `conversation_id` and `last_used_at`.
2. `routes/groups.ts` — `slugify(name)` (clean) + `reserveUniqueSlug(base, excludeConvId?)` (taken = present in `conversations.invite_slug` OR `group_slug_aliases.slug`; suffix on collision).
3. `PUT /:id` — when the name changes, derive new slug; in one transaction update `invite_slug` and insert the OLD slug into `group_slug_aliases`. Reclaim edge (rename A→B→A): if the target slug is only reserved by THIS group's own alias, delete that alias and take the clean slug.
4. `GET /:slug` and `POST /:slug/join` — on miss, fall back to the alias table → load group by `conversation_id`, bump `last_used_at`, return the group's CURRENT slug so clients re-canonicalize.
5. `GET /g/:slug` interstitial (`deepLinkFallback.ts`) — left DB-free; alias resolution + `last_used_at` bump happen in the API layer the app calls right after opening.
6. `jobs/aliasReaper.ts` — daily `node-cron` (pattern from `beaconMatcher.ts`) `DELETE FROM group_slug_aliases WHERE last_used_at < now() - 30 days`; wired into `server.ts` boot + shutdown.

## Feature 2 — Split audit design

**Locked decisions:** append-only event log for discrete events + a cheap throttled `last_active_at` column for "last seen." No row per socket connect/disconnect. Logout is skipped (no backend signal; inactivity derives it).

**Changes:**
1. `db/schema.ts` — new `user_events (id, user_id → users.id ON DELETE SET NULL [nullable], event_type varchar(40), metadata jsonb, created_at)` + indexes on `user_id` and `(event_type, created_at)`. New column `user_profiles.last_active_at timestamp`.
2. `services/userEvents.ts` — `logUserEvent(userId: number | null, type, metadata?)`; swallows errors so audit never breaks a request.
3. Instrument: `auth.ts` `/google` + `/apple` success → `login`; `auth.ts` `DELETE /account` → `account_deleted` (logged with `user_id = null` AFTER the delete succeeds, so it stays untethered); `upload.ts` confirm endpoints → `image_uploaded`.
4. `socket/index.ts` connect → throttled `last_active_at` update (`UPDATE … WHERE last_active_at IS NULL OR last_active_at < now() - interval '5 minutes'`), fire-and-forget.

## Migration & guardrails
- After schema edits: `npm run db:generate` (offline codegen; NO DB connection) → produces `0034_*.sql`. Rename file + journal tag to `0034_group_slug_aliases_and_user_events`. Strip any spurious `DROP INDEX` on pg_trgm indexes (known `db:generate` drift).
- `drizzle/meta` confirmed present + current (snapshot/journal end at 0033) before generating.
- Verify with `tsc` build only.
- Deliver final migration SQL + apply runbook. **Do NOT commit until user approves.**

## Verification
- `npm run build` (tsc) passes.
- Manual read-through of generated 0034 SQL: only additive `CREATE TABLE` / `ADD COLUMN` / `CREATE INDEX`; no destructive statements; no trgm `DROP INDEX`.
