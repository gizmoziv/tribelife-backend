-- Phase 14: pg_trgm extension for chat search (SRCH-01)
-- Hand-edited after db:generate per feedback_drizzle_migrations.md workflow.
-- Only the extension is created here. The trigram GIN indexes themselves are
-- built CONCURRENTLY out-of-band (drizzle-kit wraps every migration in a
-- transaction, and CREATE INDEX CONCURRENTLY cannot run inside one — PG 25001).
-- Run `npm run db:create-trgm-indexes` after migrating to build the indexes
-- without locking the live messages / conversations tables.
-- See 14-CONTEXT.md D-01 + 14-RESEARCH.md "Migration Content (Final)".
CREATE EXTENSION IF NOT EXISTS pg_trgm;
