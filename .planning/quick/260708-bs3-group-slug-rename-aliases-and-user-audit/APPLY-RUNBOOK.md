# Apply Runbook — Migration 0034 (group_slug_aliases + user_events)

**Live prod DB (PgBouncer transaction pool).** Additive only, zero-downtime. Run the migration BEFORE deploying the new backend code (the code reads/writes these tables). Never `SET default_transaction_read_only` on this pool.

## What it does
- Creates `group_slug_aliases` (old invite slugs → group, with `last_used_at`).
- Creates `user_events` (append-only audit log; `user_id` nullable, `ON DELETE SET NULL`).
- Adds `user_profiles.last_active_at`.
- Adds 2 FKs + 4 indexes. No destructive statements.

## Option A — apply the exact SQL by hand (recommended)

Wrap in a transaction. This is the verbatim content of
`drizzle/0034_group_slug_aliases_and_user_events.sql`:

```sql
BEGIN;

CREATE TABLE "group_slug_aliases" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(50) NOT NULL,
	"conversation_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"last_used_at" timestamp DEFAULT now(),
	CONSTRAINT "group_slug_aliases_slug_unique" UNIQUE("slug")
);

CREATE TABLE "user_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"event_type" varchar(40) NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "user_profiles" ADD COLUMN "last_active_at" timestamp;

ALTER TABLE "group_slug_aliases"
  ADD CONSTRAINT "group_slug_aliases_conversation_id_conversations_id_fk"
  FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "user_events"
  ADD CONSTRAINT "user_events_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE set null ON UPDATE no action;

CREATE INDEX "group_slug_aliases_conversation_idx" ON "group_slug_aliases" USING btree ("conversation_id");
CREATE INDEX "group_slug_aliases_last_used_idx"    ON "group_slug_aliases" USING btree ("last_used_at");
CREATE INDEX "user_events_user_idx"                ON "user_events" USING btree ("user_id");
CREATE INDEX "user_events_type_created_idx"        ON "user_events" USING btree ("event_type","created_at");

COMMIT;
```

Expected: `CREATE TABLE` ×2, `ALTER TABLE` ×3, `CREATE INDEX` ×4, then `COMMIT`.

## Option B — drizzle-kit migrate
Only if you run migrations that way normally. From `tribelife-backend/` with prod `DATABASE_URL`:
```
npm run db:migrate
```
This applies journal entry `0034_group_slug_aliases_and_user_events` and records it in `__drizzle_migrations`. (Given the PgBouncer-pool history, Option A hand-apply is the safer default.)

## Post-apply verification (read-only)
```sql
BEGIN READ ONLY;
SELECT to_regclass('public.group_slug_aliases'), to_regclass('public.user_events');
SELECT column_name FROM information_schema.columns
  WHERE table_name = 'user_profiles' AND column_name = 'last_active_at';
COMMIT;
```
Both regclasses non-null and the column present → good.

## Deploy order
1. Apply migration 0034 (above).
2. Deploy backend (adds the alias reaper cron @ 04:00 UTC + audit writes + last_active_at).
3. No mobile release required — rename now updates the slug server-side; old invite links keep resolving via aliases.
