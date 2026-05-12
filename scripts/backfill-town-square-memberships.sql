-- Backfill Town Square membership for every existing user.
-- Idempotent: re-running is a no-op (ON CONFLICT DO NOTHING).
--
-- Run once after Phase 7 deploy:
--   psql "$DATABASE_URL" -f scripts/backfill-town-square-memberships.sql
-- Or via DO droplet:
--   psql -h <host> -U <user> -d <db> -f scripts/backfill-town-square-memberships.sql
--
-- Pre-flight:
--   1. Confirm Phase 7 migration `0013_globe_room_memberships` has applied.
--      psql "$DATABASE_URL" -tAc "SELECT to_regclass('public.globe_room_memberships');"
--      Expected: globe_room_memberships
--   2. Confirm DATABASE_URL points to the intended environment (NOT a stale staging URL).
--
-- Verification:
--   The trailing SELECT inside the transaction should return 0 (zero missing memberships).
--   Re-running this script after a successful run should also produce 0 inserted rows
--   (psql will report INSERT 0 0).

BEGIN;

INSERT INTO "globe_room_memberships" ("user_id", "room_slug", "joined_at")
SELECT "id", 'town-square', NOW()
FROM "users"
ON CONFLICT ("user_id", "room_slug") DO NOTHING;

-- Verification (should return 0 missing rows after a successful run):
SELECT COUNT(*) AS missing
FROM "users" u
LEFT JOIN "globe_room_memberships" m
  ON m."user_id" = u."id" AND m."room_slug" = 'town-square'
WHERE m."id" IS NULL;

COMMIT;
