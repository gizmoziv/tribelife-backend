ALTER TABLE "access_requests" ADD COLUMN "referrer_user_id" integer;--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "referral_source" varchar(20);--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_referrer_user_id_users_id_fk" FOREIGN KEY ("referrer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;