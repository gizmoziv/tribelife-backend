CREATE TABLE "access_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"reason" text NOT NULL,
	"socials" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"decided_at" timestamp,
	"decided_by" varchar(100)
);
--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "access_status" varchar(20);--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "referral_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_requests_user_idx" ON "access_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "access_requests_status_idx" ON "access_requests" USING btree ("status");