CREATE TABLE "message_link_clicks" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" integer NOT NULL,
	"conversation_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"url" varchar(2048) NOT NULL,
	"source" varchar(10) NOT NULL,
	"platform" varchar(10) NOT NULL,
	"clicked_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_link_clicks" ADD CONSTRAINT "message_link_clicks_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_link_clicks" ADD CONSTRAINT "message_link_clicks_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_link_clicks" ADD CONSTRAINT "message_link_clicks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_link_clicks_message_idx" ON "message_link_clicks" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "message_link_clicks_message_user_idx" ON "message_link_clicks" USING btree ("message_id","user_id");--> statement-breakpoint
CREATE INDEX "message_link_clicks_conversation_clicked_idx" ON "message_link_clicks" USING btree ("conversation_id","clicked_at");--> statement-breakpoint
CREATE INDEX "message_link_clicks_user_idx" ON "message_link_clicks" USING btree ("user_id");