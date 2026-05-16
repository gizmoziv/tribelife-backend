CREATE TABLE "attribution_conversions" (
	"id" serial PRIMARY KEY NOT NULL,
	"referred_user_id" integer NOT NULL,
	"referrer_user_id" integer,
	"source" varchar(20) NOT NULL,
	"plan" varchar(50),
	"occurred_at" timestamp DEFAULT now() NOT NULL,
	"revenuecat_event_id" text
);
--> statement-breakpoint
ALTER TABLE "referrals" ADD COLUMN "source" varchar(20) DEFAULT 'handle_code' NOT NULL;--> statement-breakpoint
ALTER TABLE "attribution_conversions" ADD CONSTRAINT "attribution_conversions_referred_user_id_users_id_fk" FOREIGN KEY ("referred_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution_conversions" ADD CONSTRAINT "attribution_conversions_referrer_user_id_users_id_fk" FOREIGN KEY ("referrer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attribution_conversions_referrer_idx" ON "attribution_conversions" USING btree ("referrer_user_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "attribution_conversions_event_id_idx" ON "attribution_conversions" USING btree ("revenuecat_event_id");