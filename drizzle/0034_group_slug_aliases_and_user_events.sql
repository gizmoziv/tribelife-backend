CREATE TABLE "group_slug_aliases" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(50) NOT NULL,
	"conversation_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"last_used_at" timestamp DEFAULT now(),
	CONSTRAINT "group_slug_aliases_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "user_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"event_type" varchar(40) NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "last_active_at" timestamp;--> statement-breakpoint
ALTER TABLE "group_slug_aliases" ADD CONSTRAINT "group_slug_aliases_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_events" ADD CONSTRAINT "user_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_slug_aliases_conversation_idx" ON "group_slug_aliases" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "group_slug_aliases_last_used_idx" ON "group_slug_aliases" USING btree ("last_used_at");--> statement-breakpoint
CREATE INDEX "user_events_user_idx" ON "user_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_events_type_created_idx" ON "user_events" USING btree ("event_type","created_at");