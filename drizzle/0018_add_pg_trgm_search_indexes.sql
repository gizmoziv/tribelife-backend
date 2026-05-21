-- Phase 14: pg_trgm extension + GIN trigram indexes for chat search (SRCH-01)
-- Hand-edited after db:generate per feedback_drizzle_migrations.md workflow.
-- CREATE INDEX CONCURRENTLY and gin_trgm_ops operator class are not emitted by
-- Drizzle Kit — both are required for zero-downtime index builds on the live
-- messages table and for ILIKE acceleration via the pg_trgm GIN index.
-- See 14-CONTEXT.md D-01 + 14-RESEARCH.md "Migration Content (Final)".
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX CONCURRENTLY messages_content_trgm_idx ON messages USING GIN (content gin_trgm_ops);
CREATE INDEX CONCURRENTLY conversations_group_name_trgm_idx ON conversations USING GIN (group_name gin_trgm_ops) WHERE is_group = true;
