-- Backfill accepted_terms_at for users who completed onboarding before this
-- column existed. A non-temp handle means they passed the prior onboarding
-- screen, which already required accepting the Terms of Service — so we mark
-- them as accepted retroactively. Users with _temp_* handles stay NULL and
-- will be routed back to onboarding on next launch.
--
-- Idempotent: the WHERE accepted_terms_at IS NULL guard makes reruns a no-op.
--
-- Run with:
--   psql "$DATABASE_URL" -f scripts/backfill-accepted-terms-at.sql

BEGIN;

UPDATE "user_profiles"
SET "accepted_terms_at" = COALESCE("updated_at", "created_at", NOW())
WHERE "accepted_terms_at" IS NULL
  AND "handle" NOT LIKE '\_temp\_%' ESCAPE '\';

-- Summary so the operator can verify the row counts look right.
SELECT
  COUNT(*) FILTER (WHERE "accepted_terms_at" IS NOT NULL) AS accepted,
  COUNT(*) FILTER (WHERE "accepted_terms_at" IS NULL AND "handle" LIKE '\_temp\_%' ESCAPE '\') AS pending_onboarding,
  COUNT(*) FILTER (WHERE "accepted_terms_at" IS NULL AND "handle" NOT LIKE '\_temp\_%' ESCAPE '\') AS unexpected_null
FROM "user_profiles";

COMMIT;
