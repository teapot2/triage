ALTER TABLE "products" ADD COLUMN "category" text DEFAULT 'Home' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "rating_tenths" integer DEFAULT 45 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "review_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "art" text DEFAULT 'mug' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "tint" text DEFAULT 'sand' NOT NULL;