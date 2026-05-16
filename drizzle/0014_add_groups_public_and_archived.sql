ALTER TABLE "conversations" ADD COLUMN "is_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "archived_at" timestamp;--> statement-breakpoint
CREATE INDEX "conversations_public_active_idx" ON "conversations" USING btree ("is_public","archived_at") WHERE "conversations"."is_group" = true;