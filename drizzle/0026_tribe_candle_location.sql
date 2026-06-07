ALTER TABLE "user_profiles" ADD COLUMN "candle_geonameid" integer;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "candle_lat" double precision;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "candle_lon" double precision;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "candle_label" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "candle_source" varchar(10);