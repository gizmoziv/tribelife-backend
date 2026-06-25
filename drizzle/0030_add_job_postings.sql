CREATE TABLE "job_postings" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" varchar(50) NOT NULL,
	"external_ref" varchar(100) NOT NULL,
	"title" text NOT NULL,
	"company" varchar(255) NOT NULL,
	"location" text,
	"posted_date" varchar(20),
	"description" text,
	"logo_url" text,
	"view_count" integer DEFAULT 0 NOT NULL,
	"job_url" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "job_postings_source_external_ref_unique" UNIQUE("source","external_ref")
);
--> statement-breakpoint
CREATE INDEX "job_postings_view_count_idx" ON "job_postings" USING btree ("view_count");--> statement-breakpoint
CREATE INDEX "job_postings_posted_date_idx" ON "job_postings" USING btree ("posted_date");