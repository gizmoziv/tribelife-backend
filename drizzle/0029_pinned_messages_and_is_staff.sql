CREATE TABLE "pinned_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"room_id" varchar(100),
	"conversation_id" integer,
	"message_id" integer NOT NULL,
	"pinned_by_id" integer,
	"pinned_at" timestamp DEFAULT now() NOT NULL,
	"preview_text" text,
	"pinned_media_url" text,
	"pinned_sender_handle" varchar(50)
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_staff" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pinned_messages" ADD CONSTRAINT "pinned_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinned_messages" ADD CONSTRAINT "pinned_messages_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinned_messages" ADD CONSTRAINT "pinned_messages_pinned_by_id_users_id_fk" FOREIGN KEY ("pinned_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pinned_messages_room_uniq" ON "pinned_messages" USING btree ("room_id") WHERE "pinned_messages"."room_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pinned_messages_conv_uniq" ON "pinned_messages" USING btree ("conversation_id") WHERE "pinned_messages"."conversation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "pinned_messages_room_idx" ON "pinned_messages" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "pinned_messages_conv_idx" ON "pinned_messages" USING btree ("conversation_id");