-- Phase 16: add dms_push column (default true) to notification_preferences.
-- Backfill: carry explicit opt-outs — set dms_push=false where user had
-- mentions_push=false OR dm_push=false (CONTEXT §102-115, RESEARCH §G3).
ALTER TABLE "notification_preferences" ADD COLUMN "dms_push" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
UPDATE "notification_preferences" SET "dms_push" = false WHERE "mentions_push" = false OR "dm_push" = false;
