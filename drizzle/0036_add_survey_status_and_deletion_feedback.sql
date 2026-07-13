CREATE TABLE "account_deletion_feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"reason" varchar(30) NOT NULL,
	"other_text" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "surveys" ADD COLUMN "status" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
UPDATE "surveys" SET "status" = 'archived' WHERE "active" = false;--> statement-breakpoint
CREATE INDEX "account_deletion_feedback_created_idx" ON "account_deletion_feedback" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "surveys_status_idx" ON "surveys" USING btree ("status");