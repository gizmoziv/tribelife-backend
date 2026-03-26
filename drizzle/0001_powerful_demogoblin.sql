-- Additive schema changes for Sprint 1
-- Note: existing tables were created via drizzle-kit push, this is the first versioned migration

-- Add new columns to messages table (SCHM-01, SCHM-02)
ALTER TABLE "messages" ADD COLUMN "reply_to_id" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "media_urls" jsonb;--> statement-breakpoint

-- Add new columns to conversations table (SCHM-04)
ALTER TABLE "conversations" ADD COLUMN "is_group" boolean;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "group_name" varchar(100);--> statement-breakpoint

-- Create reactions table (SCHM-05)
CREATE TABLE "reactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"emoji" varchar(20) NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "reactions_message_id_user_id_emoji_unique" UNIQUE("message_id","user_id","emoji")
);--> statement-breakpoint

-- Add foreign keys for new tables/columns
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Add index for reactions
CREATE INDEX "reactions_message_idx" ON "reactions" USING btree ("message_id");
