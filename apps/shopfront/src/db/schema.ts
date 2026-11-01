import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  // unique so the seed can be idempotent (ON CONFLICT DO NOTHING)
  name: text("name").notNull().unique(),
  priceCents: integer("price_cents").notNull(),
  // Catalog presentation. Defaults keep rows from before these columns
  // valid; the seed (src/lib/catalog.ts) fills in the real values.
  category: text("category").notNull().default("Home"),
  description: text("description").notNull().default(""),
  // Average rating x10 (4.7 stars = 47), so it stays an integer.
  ratingTenths: integer("rating_tenths").notNull().default(45),
  reviewCount: integer("review_count").notNull().default(0),
  // The drawn placeholder for the product photo: what's pictured, and the
  // backdrop tint (see components/product-art.tsx).
  art: text("art").notNull().default("mug"),
  tint: text("tint").notNull().default("sand"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Units on hand, one row per product. Its own table, read with its own query
// (src/lib/stock.ts), like a separate inventory service: the product page
// streams it in after the rest, so a slow or failing stock lookup shows up
// in the buy box only.
export const stockLevels = pgTable("stock_levels", {
  productId: integer("product_id")
    .primaryKey()
    .references(() => products.id, { onDelete: "cascade" }),
  onHand: integer("on_hand").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// The price list: what a product sells for, kept apart from the catalog
// row so prices can change without touching product details. Filled from
// products.price_cents by syncListPrices (src/lib/prices.ts).
export const productPrices = pgTable("product_prices", {
  productId: integer("product_id")
    .primaryKey()
    .references(() => products.id, { onDelete: "cascade" }),
  amountCents: integer("amount_cents").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Customer reviews, one row per review. The star rating is 1 to 5; listings
// can average them per product (src/lib/ratings.ts) instead of reading the
// stored rating_tenths and review_count.
export const reviews = pgTable(
  "reviews",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    rating: integer("rating").notNull(),
    body: text("body").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("reviews_product_id_idx").on(t.productId),
    check("reviews_rating_range", sql`${t.rating} between 1 and 5`),
  ],
);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
