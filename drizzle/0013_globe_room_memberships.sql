CREATE TABLE "globe_room_memberships" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"room_slug" varchar(100) NOT NULL,
	"joined_at" timestamp DEFAULT now(),
	CONSTRAINT "globe_room_memberships_user_id_room_slug_unique" UNIQUE("user_id","room_slug")
);
--> statement-breakpoint
ALTER TABLE "globe_room_memberships" ADD CONSTRAINT "globe_room_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "globe_room_memberships_user_idx" ON "globe_room_memberships" USING btree ("user_id");