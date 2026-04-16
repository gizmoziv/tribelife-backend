CREATE TYPE "public"."news_importance" AS ENUM('breaking', 'major', 'routine');--> statement-breakpoint
CREATE TYPE "public"."news_ingest_method" AS ENUM('rss', 'world_news_api');--> statement-breakpoint
CREATE TABLE "news_articles" (
	"id" serial PRIMARY KEY NOT NULL,
	"outlet_id" integer NOT NULL,
	"title" text NOT NULL,
	"source_url" text NOT NULL,
	"url_hash" varchar(64) NOT NULL,
	"published_at" timestamp NOT NULL,
	"image_url" text,
	"summary" text,
	"author" varchar(255),
	"rephrased_title" text,
	"importance" "news_importance",
	"original_language" varchar(10),
	"translated_title" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "news_articles_url_hash_unique" UNIQUE("url_hash")
);
--> statement-breakpoint
CREATE TABLE "news_config" (
	"key" varchar(100) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "news_outlets" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(50) NOT NULL,
	"name" varchar(100) NOT NULL,
	"feed_url" text NOT NULL,
	"breaking_feed_url" text,
	"political_lean" varchar(20) NOT NULL,
	"ingest_method" "news_ingest_method" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "news_outlets_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "news_push_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"article_id" integer NOT NULL,
	"sent_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "news_push_history_user_id_article_id_unique" UNIQUE("user_id","article_id")
);
--> statement-breakpoint
CREATE TABLE "news_reactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"article_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"emoji" varchar(20) NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "news_reactions_article_id_user_id_emoji_unique" UNIQUE("article_id","user_id","emoji")
);
--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "news_push_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "news_articles" ADD CONSTRAINT "news_articles_outlet_id_news_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."news_outlets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_push_history" ADD CONSTRAINT "news_push_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_push_history" ADD CONSTRAINT "news_push_history_article_id_news_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."news_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_reactions" ADD CONSTRAINT "news_reactions_article_id_news_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."news_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_reactions" ADD CONSTRAINT "news_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "news_articles_published_at_idx" ON "news_articles" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "news_articles_outlet_idx" ON "news_articles" USING btree ("outlet_id");--> statement-breakpoint
CREATE INDEX "news_articles_importance_idx" ON "news_articles" USING btree ("importance");--> statement-breakpoint
CREATE INDEX "news_outlets_enabled_idx" ON "news_outlets" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "news_push_history_user_sent_idx" ON "news_push_history" USING btree ("user_id","sent_at");--> statement-breakpoint
CREATE INDEX "news_reactions_article_idx" ON "news_reactions" USING btree ("article_id");