CREATE TABLE "esek_products" (
	"id" serial PRIMARY KEY NOT NULL,
	"shopify_id" bigint NOT NULL,
	"title" text NOT NULL,
	"handle" text NOT NULL,
	"price" numeric NOT NULL,
	"compare_at_price" numeric,
	"image_url" text,
	"vendor" text,
	"product_type" text,
	"tags" jsonb,
	"available" boolean DEFAULT true NOT NULL,
	"delisted" boolean DEFAULT false NOT NULL,
	"published_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "esek_products_shopify_id_unique" UNIQUE("shopify_id")
);
--> statement-breakpoint
CREATE INDEX "esek_products_feed_idx" ON "esek_products" USING btree ("delisted","available","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);