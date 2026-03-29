CREATE TABLE "globe_read_positions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"room_slug" varchar(100) NOT NULL,
	"last_read_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "globe_read_positions_user_id_room_slug_unique" UNIQUE("user_id","room_slug")
);
--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD COLUMN "hidden_at" timestamp;--> statement-breakpoint
ALTER TABLE "globe_read_positions" ADD CONSTRAINT "globe_read_positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "globe_read_positions_user_idx" ON "globe_read_positions" USING btree ("user_id");