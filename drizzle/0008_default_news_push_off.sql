-- Flip news_push_enabled default to opt-in (false) and backfill existing rows.
-- Rationale: backend v1.3 ships before mobile v1.3 is broadly adopted. Shipping with
-- default=true would deliver 'news_breaking' push notifications to users running the
-- v1.2 mobile binary, which has no handler for the new tap type and no News tab to
-- show the article. Users explicitly opt in via the "Breaking News Notifications"
-- toggle in settings once on v1.3 mobile.

ALTER TABLE "user_profiles" ALTER COLUMN "news_push_enabled" SET DEFAULT false;
--> statement-breakpoint
-- Backfill: 0006 materializes DEFAULT true on existing rows at read time.
-- Explicit UPDATE writes false into all rows so the dispatcher query
-- `WHERE news_push_enabled=true` excludes every pre-migration user.
UPDATE "user_profiles" SET "news_push_enabled" = false WHERE "news_push_enabled" = true;