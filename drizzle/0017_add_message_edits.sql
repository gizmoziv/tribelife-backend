CREATE TABLE "message_edits" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" integer NOT NULL,
	"content" text NOT NULL,
	"edited_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "edited_at" timestamp;--> statement-breakpoint
ALTER TABLE "message_edits" ADD CONSTRAINT "message_edits_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_edits_message_idx" ON "message_edits" USING btree ("message_id");