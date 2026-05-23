-- Phase 15 (D-02): Consolidate timezone room ids from per-IANA form to canonical
-- zone slug form. Replaces room ids like `timezone:America/New_York` and
-- `timezone:America/Detroit` with the single consolidated `timezone:eastern-time`,
-- so users in NY + Detroit + Toronto see each other's pre-Phase-15 messages.
--
-- Tables remapped:
--   1. messages.room_id                  ('timezone:<iana>'  → 'timezone:<slug>')
--   2. globe_read_positions.room_slug    ('<iana>'           → '<slug>'          — BARE; not prefixed)
--   3. globe_room_memberships.room_slug  ('<iana>'           → '<slug>'          — defensive)
--   4. notifications.data.roomId (JSONB) ('timezone:<iana>'  → 'timezone:<slug>' — via jsonb_set)
--
-- Plus a btree index on globe_room_memberships(room_slug) to accelerate the
-- count-by-room queries Plan 04 layers on top (RESEARCH §I4).
--
-- IDEMPOTENCY: each UPDATE's WHERE clause matches 0 rows on re-run (the
-- room_id / room_slug has already been remapped to the zone slug). No guard
-- clauses needed. CREATE INDEX uses IF NOT EXISTS for the same reason.
--
-- DEPLOY ORDERING (RESEARCH §I2 Option C): Plan 15-01's roomHandler.ts patch
-- moved the write path to zone-slug form ahead of this migration. Plan 15-02's
-- read-path patches (chats.ts / chat.ts / auth.ts / mobile local.tsx) ship in
-- the SAME backend deploy as this migration. Plan 15-03's capability gate
-- ships AFTER this migration is verified on production.

CREATE INDEX IF NOT EXISTS "globe_room_memberships_room_slug_idx" ON "globe_room_memberships" USING btree ("room_slug");
--> statement-breakpoint

-- ── messages.room_id ─────────────────────────────────────────────
-- hawaii-time
UPDATE messages SET room_id = 'timezone:hawaii-time' WHERE room_id = 'timezone:Pacific/Honolulu';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:hawaii-time' WHERE room_id = 'timezone:Pacific/Johnston';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:hawaii-time' WHERE room_id = 'timezone:America/Adak';
--> statement-breakpoint
-- alaska-time
UPDATE messages SET room_id = 'timezone:alaska-time' WHERE room_id = 'timezone:America/Anchorage';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:alaska-time' WHERE room_id = 'timezone:America/Juneau';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:alaska-time' WHERE room_id = 'timezone:America/Nome';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:alaska-time' WHERE room_id = 'timezone:America/Sitka';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:alaska-time' WHERE room_id = 'timezone:America/Yakutat';
--> statement-breakpoint
-- pacific-time
UPDATE messages SET room_id = 'timezone:pacific-time' WHERE room_id = 'timezone:America/Los_Angeles';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:pacific-time' WHERE room_id = 'timezone:America/Vancouver';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:pacific-time' WHERE room_id = 'timezone:America/Tijuana';
--> statement-breakpoint
-- mountain-time
UPDATE messages SET room_id = 'timezone:mountain-time' WHERE room_id = 'timezone:America/Denver';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:mountain-time' WHERE room_id = 'timezone:America/Edmonton';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:mountain-time' WHERE room_id = 'timezone:America/Phoenix';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:mountain-time' WHERE room_id = 'timezone:America/Boise';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:mountain-time' WHERE room_id = 'timezone:America/Mazatlan';
--> statement-breakpoint
-- central-time
UPDATE messages SET room_id = 'timezone:central-time' WHERE room_id = 'timezone:America/Chicago';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:central-time' WHERE room_id = 'timezone:America/Winnipeg';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:central-time' WHERE room_id = 'timezone:America/Mexico_City';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:central-time' WHERE room_id = 'timezone:America/Regina';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:central-time' WHERE room_id = 'timezone:America/Indiana/Knox';
--> statement-breakpoint
-- eastern-time
UPDATE messages SET room_id = 'timezone:eastern-time' WHERE room_id = 'timezone:America/New_York';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:eastern-time' WHERE room_id = 'timezone:America/Detroit';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:eastern-time' WHERE room_id = 'timezone:America/Toronto';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:eastern-time' WHERE room_id = 'timezone:America/Indianapolis';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:eastern-time' WHERE room_id = 'timezone:America/Kentucky/Louisville';
--> statement-breakpoint
-- atlantic-time
UPDATE messages SET room_id = 'timezone:atlantic-time' WHERE room_id = 'timezone:America/Halifax';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:atlantic-time' WHERE room_id = 'timezone:America/Bermuda';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:atlantic-time' WHERE room_id = 'timezone:America/Barbados';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:atlantic-time' WHERE room_id = 'timezone:America/Puerto_Rico';
--> statement-breakpoint
-- newfoundland-time
UPDATE messages SET room_id = 'timezone:newfoundland-time' WHERE room_id = 'timezone:America/St_Johns';
--> statement-breakpoint
-- brasilia-time
UPDATE messages SET room_id = 'timezone:brasilia-time' WHERE room_id = 'timezone:America/Sao_Paulo';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:brasilia-time' WHERE room_id = 'timezone:America/Recife';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:brasilia-time' WHERE room_id = 'timezone:America/Manaus';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:brasilia-time' WHERE room_id = 'timezone:America/Fortaleza';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:brasilia-time' WHERE room_id = 'timezone:America/Belem';
--> statement-breakpoint
-- argentina-time
UPDATE messages SET room_id = 'timezone:argentina-time' WHERE room_id = 'timezone:America/Argentina/Buenos_Aires';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:argentina-time' WHERE room_id = 'timezone:America/Argentina/Cordoba';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:argentina-time' WHERE room_id = 'timezone:America/Argentina/Mendoza';
--> statement-breakpoint
-- chile-time
UPDATE messages SET room_id = 'timezone:chile-time' WHERE room_id = 'timezone:America/Santiago';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:chile-time' WHERE room_id = 'timezone:Pacific/Easter';
--> statement-breakpoint
-- colombia-peru-time
UPDATE messages SET room_id = 'timezone:colombia-peru-time' WHERE room_id = 'timezone:America/Bogota';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:colombia-peru-time' WHERE room_id = 'timezone:America/Lima';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:colombia-peru-time' WHERE room_id = 'timezone:America/Guayaquil';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:colombia-peru-time' WHERE room_id = 'timezone:America/Caracas';
--> statement-breakpoint
-- greenwich-mean-time
UPDATE messages SET room_id = 'timezone:greenwich-mean-time' WHERE room_id = 'timezone:Europe/London';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:greenwich-mean-time' WHERE room_id = 'timezone:Europe/Dublin';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:greenwich-mean-time' WHERE room_id = 'timezone:Atlantic/Reykjavik';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:greenwich-mean-time' WHERE room_id = 'timezone:Africa/Casablanca';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:greenwich-mean-time' WHERE room_id = 'timezone:Africa/Abidjan';
--> statement-breakpoint
-- central-european-time
UPDATE messages SET room_id = 'timezone:central-european-time' WHERE room_id = 'timezone:Europe/Paris';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:central-european-time' WHERE room_id = 'timezone:Europe/Berlin';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:central-european-time' WHERE room_id = 'timezone:Europe/Amsterdam';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:central-european-time' WHERE room_id = 'timezone:Europe/Brussels';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:central-european-time' WHERE room_id = 'timezone:Europe/Rome';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:central-european-time' WHERE room_id = 'timezone:Europe/Madrid';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:central-european-time' WHERE room_id = 'timezone:Europe/Zurich';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:central-european-time' WHERE room_id = 'timezone:Europe/Vienna';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:central-european-time' WHERE room_id = 'timezone:Europe/Stockholm';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:central-european-time' WHERE room_id = 'timezone:Europe/Oslo';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:central-european-time' WHERE room_id = 'timezone:Europe/Copenhagen';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:central-european-time' WHERE room_id = 'timezone:Europe/Warsaw';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:central-european-time' WHERE room_id = 'timezone:Europe/Prague';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:central-european-time' WHERE room_id = 'timezone:Europe/Budapest';
--> statement-breakpoint
-- eastern-european-time
UPDATE messages SET room_id = 'timezone:eastern-european-time' WHERE room_id = 'timezone:Europe/Bucharest';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:eastern-european-time' WHERE room_id = 'timezone:Europe/Athens';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:eastern-european-time' WHERE room_id = 'timezone:Europe/Helsinki';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:eastern-european-time' WHERE room_id = 'timezone:Africa/Cairo';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:eastern-european-time' WHERE room_id = 'timezone:Africa/Johannesburg';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:eastern-european-time' WHERE room_id = 'timezone:Africa/Harare';
--> statement-breakpoint
-- jerusalem-time
UPDATE messages SET room_id = 'timezone:jerusalem-time' WHERE room_id = 'timezone:Asia/Jerusalem';
--> statement-breakpoint
-- moscow-time
UPDATE messages SET room_id = 'timezone:moscow-time' WHERE room_id = 'timezone:Europe/Moscow';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:moscow-time' WHERE room_id = 'timezone:Europe/Istanbul';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:moscow-time' WHERE room_id = 'timezone:Asia/Riyadh';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:moscow-time' WHERE room_id = 'timezone:Asia/Baghdad';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:moscow-time' WHERE room_id = 'timezone:Africa/Nairobi';
--> statement-breakpoint
-- india-standard-time
UPDATE messages SET room_id = 'timezone:india-standard-time' WHERE room_id = 'timezone:Asia/Kolkata';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:india-standard-time' WHERE room_id = 'timezone:Asia/Colombo';
--> statement-breakpoint
-- dubai-time
UPDATE messages SET room_id = 'timezone:dubai-time' WHERE room_id = 'timezone:Asia/Dubai';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:dubai-time' WHERE room_id = 'timezone:Asia/Muscat';
--> statement-breakpoint
-- pakistan-time
UPDATE messages SET room_id = 'timezone:pakistan-time' WHERE room_id = 'timezone:Asia/Karachi';
--> statement-breakpoint
-- china-standard-time
UPDATE messages SET room_id = 'timezone:china-standard-time' WHERE room_id = 'timezone:Asia/Shanghai';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:china-standard-time' WHERE room_id = 'timezone:Asia/Singapore';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:china-standard-time' WHERE room_id = 'timezone:Asia/Hong_Kong';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:china-standard-time' WHERE room_id = 'timezone:Asia/Taipei';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:china-standard-time' WHERE room_id = 'timezone:Asia/Kuala_Lumpur';
--> statement-breakpoint
-- japan-standard-time
UPDATE messages SET room_id = 'timezone:japan-standard-time' WHERE room_id = 'timezone:Asia/Tokyo';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:japan-standard-time' WHERE room_id = 'timezone:Asia/Seoul';
--> statement-breakpoint
-- australia-eastern-time
UPDATE messages SET room_id = 'timezone:australia-eastern-time' WHERE room_id = 'timezone:Australia/Sydney';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:australia-eastern-time' WHERE room_id = 'timezone:Australia/Melbourne';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:australia-eastern-time' WHERE room_id = 'timezone:Australia/Brisbane';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:australia-eastern-time' WHERE room_id = 'timezone:Pacific/Port_Moresby';
--> statement-breakpoint
-- new-zealand-time
UPDATE messages SET room_id = 'timezone:new-zealand-time' WHERE room_id = 'timezone:Pacific/Auckland';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:new-zealand-time' WHERE room_id = 'timezone:Pacific/Fiji';
--> statement-breakpoint
-- utc
UPDATE messages SET room_id = 'timezone:utc' WHERE room_id = 'timezone:UTC';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:utc' WHERE room_id = 'timezone:Etc/UTC';
--> statement-breakpoint
UPDATE messages SET room_id = 'timezone:utc' WHERE room_id = 'timezone:Etc/GMT';
--> statement-breakpoint

-- ── globe_read_positions.room_slug (BARE — not prefixed) ─────────────────────────────────────────────
-- hawaii-time
UPDATE globe_read_positions SET room_slug = 'hawaii-time' WHERE room_slug = 'Pacific/Honolulu';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'hawaii-time' WHERE room_slug = 'Pacific/Johnston';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'hawaii-time' WHERE room_slug = 'America/Adak';
--> statement-breakpoint
-- alaska-time
UPDATE globe_read_positions SET room_slug = 'alaska-time' WHERE room_slug = 'America/Anchorage';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'alaska-time' WHERE room_slug = 'America/Juneau';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'alaska-time' WHERE room_slug = 'America/Nome';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'alaska-time' WHERE room_slug = 'America/Sitka';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'alaska-time' WHERE room_slug = 'America/Yakutat';
--> statement-breakpoint
-- pacific-time
UPDATE globe_read_positions SET room_slug = 'pacific-time' WHERE room_slug = 'America/Los_Angeles';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'pacific-time' WHERE room_slug = 'America/Vancouver';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'pacific-time' WHERE room_slug = 'America/Tijuana';
--> statement-breakpoint
-- mountain-time
UPDATE globe_read_positions SET room_slug = 'mountain-time' WHERE room_slug = 'America/Denver';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'mountain-time' WHERE room_slug = 'America/Edmonton';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'mountain-time' WHERE room_slug = 'America/Phoenix';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'mountain-time' WHERE room_slug = 'America/Boise';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'mountain-time' WHERE room_slug = 'America/Mazatlan';
--> statement-breakpoint
-- central-time
UPDATE globe_read_positions SET room_slug = 'central-time' WHERE room_slug = 'America/Chicago';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'central-time' WHERE room_slug = 'America/Winnipeg';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'central-time' WHERE room_slug = 'America/Mexico_City';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'central-time' WHERE room_slug = 'America/Regina';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'central-time' WHERE room_slug = 'America/Indiana/Knox';
--> statement-breakpoint
-- eastern-time
UPDATE globe_read_positions SET room_slug = 'eastern-time' WHERE room_slug = 'America/New_York';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'eastern-time' WHERE room_slug = 'America/Detroit';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'eastern-time' WHERE room_slug = 'America/Toronto';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'eastern-time' WHERE room_slug = 'America/Indianapolis';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'eastern-time' WHERE room_slug = 'America/Kentucky/Louisville';
--> statement-breakpoint
-- atlantic-time
UPDATE globe_read_positions SET room_slug = 'atlantic-time' WHERE room_slug = 'America/Halifax';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'atlantic-time' WHERE room_slug = 'America/Bermuda';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'atlantic-time' WHERE room_slug = 'America/Barbados';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'atlantic-time' WHERE room_slug = 'America/Puerto_Rico';
--> statement-breakpoint
-- newfoundland-time
UPDATE globe_read_positions SET room_slug = 'newfoundland-time' WHERE room_slug = 'America/St_Johns';
--> statement-breakpoint
-- brasilia-time
UPDATE globe_read_positions SET room_slug = 'brasilia-time' WHERE room_slug = 'America/Sao_Paulo';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'brasilia-time' WHERE room_slug = 'America/Recife';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'brasilia-time' WHERE room_slug = 'America/Manaus';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'brasilia-time' WHERE room_slug = 'America/Fortaleza';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'brasilia-time' WHERE room_slug = 'America/Belem';
--> statement-breakpoint
-- argentina-time
UPDATE globe_read_positions SET room_slug = 'argentina-time' WHERE room_slug = 'America/Argentina/Buenos_Aires';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'argentina-time' WHERE room_slug = 'America/Argentina/Cordoba';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'argentina-time' WHERE room_slug = 'America/Argentina/Mendoza';
--> statement-breakpoint
-- chile-time
UPDATE globe_read_positions SET room_slug = 'chile-time' WHERE room_slug = 'America/Santiago';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'chile-time' WHERE room_slug = 'Pacific/Easter';
--> statement-breakpoint
-- colombia-peru-time
UPDATE globe_read_positions SET room_slug = 'colombia-peru-time' WHERE room_slug = 'America/Bogota';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'colombia-peru-time' WHERE room_slug = 'America/Lima';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'colombia-peru-time' WHERE room_slug = 'America/Guayaquil';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'colombia-peru-time' WHERE room_slug = 'America/Caracas';
--> statement-breakpoint
-- greenwich-mean-time
UPDATE globe_read_positions SET room_slug = 'greenwich-mean-time' WHERE room_slug = 'Europe/London';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'greenwich-mean-time' WHERE room_slug = 'Europe/Dublin';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'greenwich-mean-time' WHERE room_slug = 'Atlantic/Reykjavik';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'greenwich-mean-time' WHERE room_slug = 'Africa/Casablanca';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'greenwich-mean-time' WHERE room_slug = 'Africa/Abidjan';
--> statement-breakpoint
-- central-european-time
UPDATE globe_read_positions SET room_slug = 'central-european-time' WHERE room_slug = 'Europe/Paris';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'central-european-time' WHERE room_slug = 'Europe/Berlin';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'central-european-time' WHERE room_slug = 'Europe/Amsterdam';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'central-european-time' WHERE room_slug = 'Europe/Brussels';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'central-european-time' WHERE room_slug = 'Europe/Rome';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'central-european-time' WHERE room_slug = 'Europe/Madrid';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'central-european-time' WHERE room_slug = 'Europe/Zurich';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'central-european-time' WHERE room_slug = 'Europe/Vienna';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'central-european-time' WHERE room_slug = 'Europe/Stockholm';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'central-european-time' WHERE room_slug = 'Europe/Oslo';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'central-european-time' WHERE room_slug = 'Europe/Copenhagen';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'central-european-time' WHERE room_slug = 'Europe/Warsaw';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'central-european-time' WHERE room_slug = 'Europe/Prague';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'central-european-time' WHERE room_slug = 'Europe/Budapest';
--> statement-breakpoint
-- eastern-european-time
UPDATE globe_read_positions SET room_slug = 'eastern-european-time' WHERE room_slug = 'Europe/Bucharest';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'eastern-european-time' WHERE room_slug = 'Europe/Athens';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'eastern-european-time' WHERE room_slug = 'Europe/Helsinki';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'eastern-european-time' WHERE room_slug = 'Africa/Cairo';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'eastern-european-time' WHERE room_slug = 'Africa/Johannesburg';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'eastern-european-time' WHERE room_slug = 'Africa/Harare';
--> statement-breakpoint
-- jerusalem-time
UPDATE globe_read_positions SET room_slug = 'jerusalem-time' WHERE room_slug = 'Asia/Jerusalem';
--> statement-breakpoint
-- moscow-time
UPDATE globe_read_positions SET room_slug = 'moscow-time' WHERE room_slug = 'Europe/Moscow';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'moscow-time' WHERE room_slug = 'Europe/Istanbul';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'moscow-time' WHERE room_slug = 'Asia/Riyadh';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'moscow-time' WHERE room_slug = 'Asia/Baghdad';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'moscow-time' WHERE room_slug = 'Africa/Nairobi';
--> statement-breakpoint
-- india-standard-time
UPDATE globe_read_positions SET room_slug = 'india-standard-time' WHERE room_slug = 'Asia/Kolkata';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'india-standard-time' WHERE room_slug = 'Asia/Colombo';
--> statement-breakpoint
-- dubai-time
UPDATE globe_read_positions SET room_slug = 'dubai-time' WHERE room_slug = 'Asia/Dubai';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'dubai-time' WHERE room_slug = 'Asia/Muscat';
--> statement-breakpoint
-- pakistan-time
UPDATE globe_read_positions SET room_slug = 'pakistan-time' WHERE room_slug = 'Asia/Karachi';
--> statement-breakpoint
-- china-standard-time
UPDATE globe_read_positions SET room_slug = 'china-standard-time' WHERE room_slug = 'Asia/Shanghai';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'china-standard-time' WHERE room_slug = 'Asia/Singapore';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'china-standard-time' WHERE room_slug = 'Asia/Hong_Kong';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'china-standard-time' WHERE room_slug = 'Asia/Taipei';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'china-standard-time' WHERE room_slug = 'Asia/Kuala_Lumpur';
--> statement-breakpoint
-- japan-standard-time
UPDATE globe_read_positions SET room_slug = 'japan-standard-time' WHERE room_slug = 'Asia/Tokyo';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'japan-standard-time' WHERE room_slug = 'Asia/Seoul';
--> statement-breakpoint
-- australia-eastern-time
UPDATE globe_read_positions SET room_slug = 'australia-eastern-time' WHERE room_slug = 'Australia/Sydney';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'australia-eastern-time' WHERE room_slug = 'Australia/Melbourne';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'australia-eastern-time' WHERE room_slug = 'Australia/Brisbane';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'australia-eastern-time' WHERE room_slug = 'Pacific/Port_Moresby';
--> statement-breakpoint
-- new-zealand-time
UPDATE globe_read_positions SET room_slug = 'new-zealand-time' WHERE room_slug = 'Pacific/Auckland';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'new-zealand-time' WHERE room_slug = 'Pacific/Fiji';
--> statement-breakpoint
-- utc
UPDATE globe_read_positions SET room_slug = 'utc' WHERE room_slug = 'UTC';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'utc' WHERE room_slug = 'Etc/UTC';
--> statement-breakpoint
UPDATE globe_read_positions SET room_slug = 'utc' WHERE room_slug = 'Etc/GMT';
--> statement-breakpoint

-- ── globe_room_memberships.room_slug (defensive) ─────────────────────────────────────────────
-- hawaii-time
UPDATE globe_room_memberships SET room_slug = 'hawaii-time' WHERE room_slug = 'Pacific/Honolulu';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'hawaii-time' WHERE room_slug = 'Pacific/Johnston';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'hawaii-time' WHERE room_slug = 'America/Adak';
--> statement-breakpoint
-- alaska-time
UPDATE globe_room_memberships SET room_slug = 'alaska-time' WHERE room_slug = 'America/Anchorage';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'alaska-time' WHERE room_slug = 'America/Juneau';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'alaska-time' WHERE room_slug = 'America/Nome';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'alaska-time' WHERE room_slug = 'America/Sitka';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'alaska-time' WHERE room_slug = 'America/Yakutat';
--> statement-breakpoint
-- pacific-time
UPDATE globe_room_memberships SET room_slug = 'pacific-time' WHERE room_slug = 'America/Los_Angeles';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'pacific-time' WHERE room_slug = 'America/Vancouver';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'pacific-time' WHERE room_slug = 'America/Tijuana';
--> statement-breakpoint
-- mountain-time
UPDATE globe_room_memberships SET room_slug = 'mountain-time' WHERE room_slug = 'America/Denver';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'mountain-time' WHERE room_slug = 'America/Edmonton';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'mountain-time' WHERE room_slug = 'America/Phoenix';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'mountain-time' WHERE room_slug = 'America/Boise';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'mountain-time' WHERE room_slug = 'America/Mazatlan';
--> statement-breakpoint
-- central-time
UPDATE globe_room_memberships SET room_slug = 'central-time' WHERE room_slug = 'America/Chicago';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'central-time' WHERE room_slug = 'America/Winnipeg';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'central-time' WHERE room_slug = 'America/Mexico_City';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'central-time' WHERE room_slug = 'America/Regina';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'central-time' WHERE room_slug = 'America/Indiana/Knox';
--> statement-breakpoint
-- eastern-time
UPDATE globe_room_memberships SET room_slug = 'eastern-time' WHERE room_slug = 'America/New_York';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'eastern-time' WHERE room_slug = 'America/Detroit';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'eastern-time' WHERE room_slug = 'America/Toronto';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'eastern-time' WHERE room_slug = 'America/Indianapolis';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'eastern-time' WHERE room_slug = 'America/Kentucky/Louisville';
--> statement-breakpoint
-- atlantic-time
UPDATE globe_room_memberships SET room_slug = 'atlantic-time' WHERE room_slug = 'America/Halifax';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'atlantic-time' WHERE room_slug = 'America/Bermuda';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'atlantic-time' WHERE room_slug = 'America/Barbados';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'atlantic-time' WHERE room_slug = 'America/Puerto_Rico';
--> statement-breakpoint
-- newfoundland-time
UPDATE globe_room_memberships SET room_slug = 'newfoundland-time' WHERE room_slug = 'America/St_Johns';
--> statement-breakpoint
-- brasilia-time
UPDATE globe_room_memberships SET room_slug = 'brasilia-time' WHERE room_slug = 'America/Sao_Paulo';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'brasilia-time' WHERE room_slug = 'America/Recife';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'brasilia-time' WHERE room_slug = 'America/Manaus';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'brasilia-time' WHERE room_slug = 'America/Fortaleza';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'brasilia-time' WHERE room_slug = 'America/Belem';
--> statement-breakpoint
-- argentina-time
UPDATE globe_room_memberships SET room_slug = 'argentina-time' WHERE room_slug = 'America/Argentina/Buenos_Aires';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'argentina-time' WHERE room_slug = 'America/Argentina/Cordoba';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'argentina-time' WHERE room_slug = 'America/Argentina/Mendoza';
--> statement-breakpoint
-- chile-time
UPDATE globe_room_memberships SET room_slug = 'chile-time' WHERE room_slug = 'America/Santiago';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'chile-time' WHERE room_slug = 'Pacific/Easter';
--> statement-breakpoint
-- colombia-peru-time
UPDATE globe_room_memberships SET room_slug = 'colombia-peru-time' WHERE room_slug = 'America/Bogota';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'colombia-peru-time' WHERE room_slug = 'America/Lima';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'colombia-peru-time' WHERE room_slug = 'America/Guayaquil';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'colombia-peru-time' WHERE room_slug = 'America/Caracas';
--> statement-breakpoint
-- greenwich-mean-time
UPDATE globe_room_memberships SET room_slug = 'greenwich-mean-time' WHERE room_slug = 'Europe/London';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'greenwich-mean-time' WHERE room_slug = 'Europe/Dublin';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'greenwich-mean-time' WHERE room_slug = 'Atlantic/Reykjavik';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'greenwich-mean-time' WHERE room_slug = 'Africa/Casablanca';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'greenwich-mean-time' WHERE room_slug = 'Africa/Abidjan';
--> statement-breakpoint
-- central-european-time
UPDATE globe_room_memberships SET room_slug = 'central-european-time' WHERE room_slug = 'Europe/Paris';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'central-european-time' WHERE room_slug = 'Europe/Berlin';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'central-european-time' WHERE room_slug = 'Europe/Amsterdam';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'central-european-time' WHERE room_slug = 'Europe/Brussels';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'central-european-time' WHERE room_slug = 'Europe/Rome';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'central-european-time' WHERE room_slug = 'Europe/Madrid';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'central-european-time' WHERE room_slug = 'Europe/Zurich';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'central-european-time' WHERE room_slug = 'Europe/Vienna';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'central-european-time' WHERE room_slug = 'Europe/Stockholm';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'central-european-time' WHERE room_slug = 'Europe/Oslo';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'central-european-time' WHERE room_slug = 'Europe/Copenhagen';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'central-european-time' WHERE room_slug = 'Europe/Warsaw';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'central-european-time' WHERE room_slug = 'Europe/Prague';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'central-european-time' WHERE room_slug = 'Europe/Budapest';
--> statement-breakpoint
-- eastern-european-time
UPDATE globe_room_memberships SET room_slug = 'eastern-european-time' WHERE room_slug = 'Europe/Bucharest';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'eastern-european-time' WHERE room_slug = 'Europe/Athens';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'eastern-european-time' WHERE room_slug = 'Europe/Helsinki';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'eastern-european-time' WHERE room_slug = 'Africa/Cairo';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'eastern-european-time' WHERE room_slug = 'Africa/Johannesburg';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'eastern-european-time' WHERE room_slug = 'Africa/Harare';
--> statement-breakpoint
-- jerusalem-time
UPDATE globe_room_memberships SET room_slug = 'jerusalem-time' WHERE room_slug = 'Asia/Jerusalem';
--> statement-breakpoint
-- moscow-time
UPDATE globe_room_memberships SET room_slug = 'moscow-time' WHERE room_slug = 'Europe/Moscow';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'moscow-time' WHERE room_slug = 'Europe/Istanbul';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'moscow-time' WHERE room_slug = 'Asia/Riyadh';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'moscow-time' WHERE room_slug = 'Asia/Baghdad';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'moscow-time' WHERE room_slug = 'Africa/Nairobi';
--> statement-breakpoint
-- india-standard-time
UPDATE globe_room_memberships SET room_slug = 'india-standard-time' WHERE room_slug = 'Asia/Kolkata';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'india-standard-time' WHERE room_slug = 'Asia/Colombo';
--> statement-breakpoint
-- dubai-time
UPDATE globe_room_memberships SET room_slug = 'dubai-time' WHERE room_slug = 'Asia/Dubai';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'dubai-time' WHERE room_slug = 'Asia/Muscat';
--> statement-breakpoint
-- pakistan-time
UPDATE globe_room_memberships SET room_slug = 'pakistan-time' WHERE room_slug = 'Asia/Karachi';
--> statement-breakpoint
-- china-standard-time
UPDATE globe_room_memberships SET room_slug = 'china-standard-time' WHERE room_slug = 'Asia/Shanghai';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'china-standard-time' WHERE room_slug = 'Asia/Singapore';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'china-standard-time' WHERE room_slug = 'Asia/Hong_Kong';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'china-standard-time' WHERE room_slug = 'Asia/Taipei';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'china-standard-time' WHERE room_slug = 'Asia/Kuala_Lumpur';
--> statement-breakpoint
-- japan-standard-time
UPDATE globe_room_memberships SET room_slug = 'japan-standard-time' WHERE room_slug = 'Asia/Tokyo';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'japan-standard-time' WHERE room_slug = 'Asia/Seoul';
--> statement-breakpoint
-- australia-eastern-time
UPDATE globe_room_memberships SET room_slug = 'australia-eastern-time' WHERE room_slug = 'Australia/Sydney';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'australia-eastern-time' WHERE room_slug = 'Australia/Melbourne';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'australia-eastern-time' WHERE room_slug = 'Australia/Brisbane';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'australia-eastern-time' WHERE room_slug = 'Pacific/Port_Moresby';
--> statement-breakpoint
-- new-zealand-time
UPDATE globe_room_memberships SET room_slug = 'new-zealand-time' WHERE room_slug = 'Pacific/Auckland';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'new-zealand-time' WHERE room_slug = 'Pacific/Fiji';
--> statement-breakpoint
-- utc
UPDATE globe_room_memberships SET room_slug = 'utc' WHERE room_slug = 'UTC';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'utc' WHERE room_slug = 'Etc/UTC';
--> statement-breakpoint
UPDATE globe_room_memberships SET room_slug = 'utc' WHERE room_slug = 'Etc/GMT';
--> statement-breakpoint

-- ── notifications.data.roomId (JSONB) ─────────────────────────────────────────────
-- hawaii-time
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:hawaii-time"') WHERE data->>'roomId' = 'timezone:Pacific/Honolulu';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:hawaii-time"') WHERE data->>'roomId' = 'timezone:Pacific/Johnston';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:hawaii-time"') WHERE data->>'roomId' = 'timezone:America/Adak';
--> statement-breakpoint
-- alaska-time
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:alaska-time"') WHERE data->>'roomId' = 'timezone:America/Anchorage';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:alaska-time"') WHERE data->>'roomId' = 'timezone:America/Juneau';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:alaska-time"') WHERE data->>'roomId' = 'timezone:America/Nome';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:alaska-time"') WHERE data->>'roomId' = 'timezone:America/Sitka';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:alaska-time"') WHERE data->>'roomId' = 'timezone:America/Yakutat';
--> statement-breakpoint
-- pacific-time
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:pacific-time"') WHERE data->>'roomId' = 'timezone:America/Los_Angeles';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:pacific-time"') WHERE data->>'roomId' = 'timezone:America/Vancouver';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:pacific-time"') WHERE data->>'roomId' = 'timezone:America/Tijuana';
--> statement-breakpoint
-- mountain-time
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:mountain-time"') WHERE data->>'roomId' = 'timezone:America/Denver';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:mountain-time"') WHERE data->>'roomId' = 'timezone:America/Edmonton';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:mountain-time"') WHERE data->>'roomId' = 'timezone:America/Phoenix';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:mountain-time"') WHERE data->>'roomId' = 'timezone:America/Boise';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:mountain-time"') WHERE data->>'roomId' = 'timezone:America/Mazatlan';
--> statement-breakpoint
-- central-time
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:central-time"') WHERE data->>'roomId' = 'timezone:America/Chicago';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:central-time"') WHERE data->>'roomId' = 'timezone:America/Winnipeg';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:central-time"') WHERE data->>'roomId' = 'timezone:America/Mexico_City';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:central-time"') WHERE data->>'roomId' = 'timezone:America/Regina';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:central-time"') WHERE data->>'roomId' = 'timezone:America/Indiana/Knox';
--> statement-breakpoint
-- eastern-time
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:eastern-time"') WHERE data->>'roomId' = 'timezone:America/New_York';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:eastern-time"') WHERE data->>'roomId' = 'timezone:America/Detroit';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:eastern-time"') WHERE data->>'roomId' = 'timezone:America/Toronto';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:eastern-time"') WHERE data->>'roomId' = 'timezone:America/Indianapolis';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:eastern-time"') WHERE data->>'roomId' = 'timezone:America/Kentucky/Louisville';
--> statement-breakpoint
-- atlantic-time
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:atlantic-time"') WHERE data->>'roomId' = 'timezone:America/Halifax';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:atlantic-time"') WHERE data->>'roomId' = 'timezone:America/Bermuda';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:atlantic-time"') WHERE data->>'roomId' = 'timezone:America/Barbados';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:atlantic-time"') WHERE data->>'roomId' = 'timezone:America/Puerto_Rico';
--> statement-breakpoint
-- newfoundland-time
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:newfoundland-time"') WHERE data->>'roomId' = 'timezone:America/St_Johns';
--> statement-breakpoint
-- brasilia-time
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:brasilia-time"') WHERE data->>'roomId' = 'timezone:America/Sao_Paulo';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:brasilia-time"') WHERE data->>'roomId' = 'timezone:America/Recife';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:brasilia-time"') WHERE data->>'roomId' = 'timezone:America/Manaus';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:brasilia-time"') WHERE data->>'roomId' = 'timezone:America/Fortaleza';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:brasilia-time"') WHERE data->>'roomId' = 'timezone:America/Belem';
--> statement-breakpoint
-- argentina-time
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:argentina-time"') WHERE data->>'roomId' = 'timezone:America/Argentina/Buenos_Aires';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:argentina-time"') WHERE data->>'roomId' = 'timezone:America/Argentina/Cordoba';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:argentina-time"') WHERE data->>'roomId' = 'timezone:America/Argentina/Mendoza';
--> statement-breakpoint
-- chile-time
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:chile-time"') WHERE data->>'roomId' = 'timezone:America/Santiago';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:chile-time"') WHERE data->>'roomId' = 'timezone:Pacific/Easter';
--> statement-breakpoint
-- colombia-peru-time
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:colombia-peru-time"') WHERE data->>'roomId' = 'timezone:America/Bogota';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:colombia-peru-time"') WHERE data->>'roomId' = 'timezone:America/Lima';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:colombia-peru-time"') WHERE data->>'roomId' = 'timezone:America/Guayaquil';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:colombia-peru-time"') WHERE data->>'roomId' = 'timezone:America/Caracas';
--> statement-breakpoint
-- greenwich-mean-time
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:greenwich-mean-time"') WHERE data->>'roomId' = 'timezone:Europe/London';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:greenwich-mean-time"') WHERE data->>'roomId' = 'timezone:Europe/Dublin';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:greenwich-mean-time"') WHERE data->>'roomId' = 'timezone:Atlantic/Reykjavik';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:greenwich-mean-time"') WHERE data->>'roomId' = 'timezone:Africa/Casablanca';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:greenwich-mean-time"') WHERE data->>'roomId' = 'timezone:Africa/Abidjan';
--> statement-breakpoint
-- central-european-time
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:central-european-time"') WHERE data->>'roomId' = 'timezone:Europe/Paris';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:central-european-time"') WHERE data->>'roomId' = 'timezone:Europe/Berlin';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:central-european-time"') WHERE data->>'roomId' = 'timezone:Europe/Amsterdam';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:central-european-time"') WHERE data->>'roomId' = 'timezone:Europe/Brussels';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:central-european-time"') WHERE data->>'roomId' = 'timezone:Europe/Rome';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:central-european-time"') WHERE data->>'roomId' = 'timezone:Europe/Madrid';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:central-european-time"') WHERE data->>'roomId' = 'timezone:Europe/Zurich';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:central-european-time"') WHERE data->>'roomId' = 'timezone:Europe/Vienna';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:central-european-time"') WHERE data->>'roomId' = 'timezone:Europe/Stockholm';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:central-european-time"') WHERE data->>'roomId' = 'timezone:Europe/Oslo';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:central-european-time"') WHERE data->>'roomId' = 'timezone:Europe/Copenhagen';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:central-european-time"') WHERE data->>'roomId' = 'timezone:Europe/Warsaw';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:central-european-time"') WHERE data->>'roomId' = 'timezone:Europe/Prague';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:central-european-time"') WHERE data->>'roomId' = 'timezone:Europe/Budapest';
--> statement-breakpoint
-- eastern-european-time
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:eastern-european-time"') WHERE data->>'roomId' = 'timezone:Europe/Bucharest';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:eastern-european-time"') WHERE data->>'roomId' = 'timezone:Europe/Athens';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:eastern-european-time"') WHERE data->>'roomId' = 'timezone:Europe/Helsinki';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:eastern-european-time"') WHERE data->>'roomId' = 'timezone:Africa/Cairo';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:eastern-european-time"') WHERE data->>'roomId' = 'timezone:Africa/Johannesburg';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:eastern-european-time"') WHERE data->>'roomId' = 'timezone:Africa/Harare';
--> statement-breakpoint
-- jerusalem-time
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:jerusalem-time"') WHERE data->>'roomId' = 'timezone:Asia/Jerusalem';
--> statement-breakpoint
-- moscow-time
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:moscow-time"') WHERE data->>'roomId' = 'timezone:Europe/Moscow';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:moscow-time"') WHERE data->>'roomId' = 'timezone:Europe/Istanbul';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:moscow-time"') WHERE data->>'roomId' = 'timezone:Asia/Riyadh';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:moscow-time"') WHERE data->>'roomId' = 'timezone:Asia/Baghdad';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:moscow-time"') WHERE data->>'roomId' = 'timezone:Africa/Nairobi';
--> statement-breakpoint
-- india-standard-time
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:india-standard-time"') WHERE data->>'roomId' = 'timezone:Asia/Kolkata';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:india-standard-time"') WHERE data->>'roomId' = 'timezone:Asia/Colombo';
--> statement-breakpoint
-- dubai-time
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:dubai-time"') WHERE data->>'roomId' = 'timezone:Asia/Dubai';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:dubai-time"') WHERE data->>'roomId' = 'timezone:Asia/Muscat';
--> statement-breakpoint
-- pakistan-time
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:pakistan-time"') WHERE data->>'roomId' = 'timezone:Asia/Karachi';
--> statement-breakpoint
-- china-standard-time
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:china-standard-time"') WHERE data->>'roomId' = 'timezone:Asia/Shanghai';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:china-standard-time"') WHERE data->>'roomId' = 'timezone:Asia/Singapore';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:china-standard-time"') WHERE data->>'roomId' = 'timezone:Asia/Hong_Kong';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:china-standard-time"') WHERE data->>'roomId' = 'timezone:Asia/Taipei';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:china-standard-time"') WHERE data->>'roomId' = 'timezone:Asia/Kuala_Lumpur';
--> statement-breakpoint
-- japan-standard-time
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:japan-standard-time"') WHERE data->>'roomId' = 'timezone:Asia/Tokyo';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:japan-standard-time"') WHERE data->>'roomId' = 'timezone:Asia/Seoul';
--> statement-breakpoint
-- australia-eastern-time
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:australia-eastern-time"') WHERE data->>'roomId' = 'timezone:Australia/Sydney';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:australia-eastern-time"') WHERE data->>'roomId' = 'timezone:Australia/Melbourne';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:australia-eastern-time"') WHERE data->>'roomId' = 'timezone:Australia/Brisbane';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:australia-eastern-time"') WHERE data->>'roomId' = 'timezone:Pacific/Port_Moresby';
--> statement-breakpoint
-- new-zealand-time
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:new-zealand-time"') WHERE data->>'roomId' = 'timezone:Pacific/Auckland';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:new-zealand-time"') WHERE data->>'roomId' = 'timezone:Pacific/Fiji';
--> statement-breakpoint
-- utc
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:utc"') WHERE data->>'roomId' = 'timezone:UTC';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:utc"') WHERE data->>'roomId' = 'timezone:Etc/UTC';
--> statement-breakpoint
UPDATE notifications SET data = jsonb_set(data, '{roomId}', '"timezone:utc"') WHERE data->>'roomId' = 'timezone:Etc/GMT';
--> statement-breakpoint
