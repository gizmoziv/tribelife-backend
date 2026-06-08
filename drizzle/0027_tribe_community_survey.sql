CREATE TABLE "survey_options" (
	"id" serial PRIMARY KEY NOT NULL,
	"survey_id" integer NOT NULL,
	"label" text NOT NULL,
	"is_other" boolean DEFAULT false NOT NULL,
	"display_order" integer NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "survey_votes" (
	"id" serial PRIMARY KEY NOT NULL,
	"survey_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"option_id" integer NOT NULL,
	"other_text" text,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "survey_votes_survey_user_unique" UNIQUE("survey_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "surveys" (
	"id" serial PRIMARY KEY NOT NULL,
	"question_text" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "survey_options" ADD CONSTRAINT "survey_options_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_votes" ADD CONSTRAINT "survey_votes_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_votes" ADD CONSTRAINT "survey_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_votes" ADD CONSTRAINT "survey_votes_option_id_survey_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."survey_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "survey_options_survey_idx" ON "survey_options" USING btree ("survey_id");--> statement-breakpoint
CREATE INDEX "survey_votes_survey_idx" ON "survey_votes" USING btree ("survey_id");--> statement-breakpoint
CREATE INDEX "survey_votes_option_idx" ON "survey_votes" USING btree ("option_id");--> statement-breakpoint
CREATE INDEX "surveys_active_idx" ON "surveys" USING btree ("active");--> statement-breakpoint

-- ── Launch Survey Seed (D-01 / D-02 / D-03) ────────────────────────────────
-- Seeds the initial active survey with the 4 operator-approved options.
-- Runs inside the same migration transaction.
-- Expected output: INSERT 0 1 (surveys), INSERT 0 4 (survey_options).
WITH inserted_survey AS (
  INSERT INTO surveys (question_text, active)
  VALUES ('What would make TribeLife more useful to you?', true)
  RETURNING id
)
INSERT INTO survey_options (survey_id, label, is_other, display_order)
SELECT
  inserted_survey.id,
  opt.label,
  opt.is_other,
  opt.display_order
FROM inserted_survey
CROSS JOIN (VALUES
  ('Jobs & opportunities board',  false, 1),
  ('Events & meetups',            false, 2),
  ('Marketplace / classifieds',   false, 3),
  ('Other (tell us)',             true,  4)
) AS opt(label, is_other, display_order);
