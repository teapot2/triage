// Generated from apps/shopfront at 0dfdbac (the release the bad-deploy scenario
// records: "feat(shopfront): return a formatted price from the product API"):
// the files the scenario serves, verbatim. Regenerate rather than edit, so the
// scenario keeps matching the release.

export const badDeployFiles: Record<string, string> = {
  "drizzle/0004_product_prices.sql": `CREATE TABLE "product_prices" (
	"product_id" integer PRIMARY KEY NOT NULL,
	"amount_cents" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;`,
  "drizzle/0005_reviews.sql": `CREATE TABLE "reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"rating" integer NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_rating_range" CHECK ("reviews"."rating" between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reviews_product_id_idx" ON "reviews" USING btree ("product_id");`,
  "src/app/(store)/products/[id]/loading.tsx": `// Shown while a product page loads, in the page's own layout, so a slow
// database reads as "loading", not as a frozen link.
export default function Loading() {
  return (
    <div className="mx-auto max-w-6xl px-4 pt-6 sm:px-6" aria-busy="true" aria-label="Loading product">
      <div className="h-5 w-56 animate-pulse rounded bg-secondary" />
      <div className="mt-6 grid gap-8 md:grid-cols-2 lg:gap-14">
        <div className="aspect-[4/3] animate-pulse rounded-xl bg-secondary sm:aspect-square" />
        <div className="space-y-4 md:py-4">
          <div className="h-4 w-20 animate-pulse rounded bg-secondary" />
          <div className="h-9 w-3/4 animate-pulse rounded bg-secondary" />
          <div className="h-4 w-40 animate-pulse rounded bg-secondary" />
          <div className="h-7 w-16 animate-pulse rounded bg-secondary" />
          <div className="h-16 w-full animate-pulse rounded bg-secondary" />
          <div className="h-12 w-full animate-pulse rounded-lg bg-secondary" />
        </div>
      </div>
    </div>
  );
}
`,
  "src/app/(store)/products/[id]/page.tsx": `import { ChevronRight, Star } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { BuyBox, BuyBoxSkeleton } from "@/components/buy-box";
import { ProductImage } from "@/components/product-image";
import { ProductCard } from "@/components/product-card";
import { categories, categoryDetails, formatPrice, type Category } from "@/lib/catalog";
import { priceOf } from "@/lib/prices";
import { getProduct, getRelated, parseProductId } from "@/lib/products";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const id = parseProductId((await params).id);
  // If the database is down the page itself shows the error; the tab just
  // gets a plain title rather than the bare URL.
  const product = id ? await getProduct(id).catch(() => undefined) : null;
  if (product === undefined) return { title: "Product" };
  return product ? { title: product.name, description: product.description } : { title: "Product not found" };
}

export default async function ProductPage({ params }: Props) {
  const id = parseProductId((await params).id);
  if (!id) notFound();
  const product = await getProduct(id);
  if (!product) notFound();
  const priceCents = await priceOf(product);

  const category = categories.find((c) => c === product.category);
  const details = category ? categoryDetails[category] : null;
  const rating = product.ratingTenths / 10;
  const categoryHref = \`/?category=\${encodeURIComponent(product.category)}#shop\`;

  return (
    <div className="mx-auto max-w-6xl px-4 pt-6 sm:px-6">
      <nav aria-label="Breadcrumb">
        <ol className="flex items-center gap-1 text-sm text-muted-foreground">
          <li>
            <Link href="/" className="hover:text-foreground">
              Home
            </Link>
            <ChevronRight className="ml-1 inline size-3.5 align-[-2px]" aria-hidden="true" />
          </li>
          <li>
            <Link href={categoryHref} className="hover:text-foreground">
              {product.category}
            </Link>
            <ChevronRight className="ml-1 inline size-3.5 align-[-2px]" aria-hidden="true" />
          </li>
          <li aria-current="page" className="min-w-0 truncate text-foreground">
            {product.name}
          </li>
        </ol>
      </nav>

      <div className="mt-6 grid gap-8 md:grid-cols-2 lg:gap-14">
        <div className="aspect-[4/3] overflow-hidden rounded-xl sm:aspect-square md:sticky md:top-24 md:self-start">
          <ProductImage name={product.name} art={product.art} tint={product.tint} sizes="(min-width: 768px) 50vw, 100vw" preload />
        </div>

        <div className="md:py-4">
          <Link href={categoryHref} className="text-sm font-medium text-primary hover:underline hover:underline-offset-4">
            {product.category}
          </Link>
          <h1 className="mt-2 font-serif text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-4xl">
            {product.name}
          </h1>
          <div className="mt-3 flex items-center gap-2 text-sm">
            <Stars rating={rating} />
            <span className="font-medium tabular-nums">{rating.toFixed(1)}</span>
            <span className="text-muted-foreground tabular-nums">
              ({product.reviewCount.toLocaleString("en-US")} reviews)
            </span>
          </div>
          <p className="mt-5 text-2xl font-medium tabular-nums">{formatPrice(priceCents)}</p>
          <p className="mt-5 max-w-prose text-muted-foreground text-pretty">{product.description}</p>

          <div className="mt-8 border-t pt-6">
            <Suspense fallback={<BuyBoxSkeleton />}>
              <BuyBox productId={product.id} />
            </Suspense>
          </div>

          <div className="mt-8 divide-y border-y">
            {details && (
              <>
                <Detail title="Materials" open>
                  {details.materials}
                </Detail>
                <Detail title="Care">{details.care}</Detail>
              </>
            )}
            <Detail title="Shipping and returns">
              Free shipping on orders over $75, otherwise $6. Ships in 1–2 business days. Return anything unused
              within 30 days for a full refund.
            </Detail>
          </div>
        </div>
      </div>

      <Suspense>
        <Related category={product.category as Category} productId={product.id} />
      </Suspense>
    </div>
  );
}

function Stars({ rating }: { rating: number }) {
  return (
    <span className="flex" role="img" aria-label={\`Rated \${rating.toFixed(1)} out of 5\`}>
      {[1, 2, 3, 4, 5].map((n) => {
        // How much of this star to fill: whole, none, or the remainder.
        const fill = Math.max(0, Math.min(1, rating - (n - 1)));
        return (
          <span key={n} className="relative size-4">
            <Star className="absolute inset-0 size-4 text-star/30" fill="currentColor" strokeWidth={0} />
            <span className="absolute inset-0 overflow-hidden" style={{ width: \`\${fill * 100}%\` }}>
              <Star className="size-4 text-star" fill="currentColor" strokeWidth={0} />
            </span>
          </span>
        );
      })}
    </span>
  );
}

function Detail({ title, open, children }: { title: string; open?: boolean; children: ReactNode }) {
  return (
    <details open={open} className="group py-4">
      <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none" />
      </summary>
      <p className="mt-2 text-sm text-muted-foreground">{children}</p>
    </details>
  );
}

// More from the same category. Not essential to buying, so if it fails the
// section is simply left out.
async function Related({ category, productId }: { category: Category; productId: number }) {
  const rows = await getRelated(category, productId).catch(() => []);
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="related-title" className="mt-24">
      <h2 id="related-title" className="font-serif text-2xl font-semibold tracking-tight">
        More from {category}
      </h2>
      <ul className="mt-6 grid grid-cols-2 gap-x-4 gap-y-10 sm:gap-x-6 lg:grid-cols-4">
        {rows.map((p) => (
          <li key={p.id}>
            <ProductCard product={p} />
          </li>
        ))}
      </ul>
    </section>
  );
}
`,
  "src/app/api/products/[id]/route.ts": `import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { products } from "@/db/schema";
import { logger } from "@/lib/logger";
import { formatPrice } from "@/lib/money";
import { priceOf } from "@/lib/prices";
import { getStockLevel } from "@/lib/stock";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await ctx.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "invalid id" }, { status: 400 });
  }

  const [product] = await db.select().from(products).where(eq(products.id, id)).limit(1);
  logger.info("fetched product", { "product.id": id, "product.found": Boolean(product) });

  if (!product) return Response.json({ error: "not found" }, { status: 404 });
  const priceCents = await priceOf(product);
  const stock = await getStockLevel(product.id);
  return Response.json({ ...product, priceCents, price: formatPrice(priceCents), stock });
}
`,
  "src/app/api/products/route.ts": `import { asc } from "drizzle-orm";
import { db } from "@/db/client";
import { products } from "@/db/schema";
import { logger } from "@/lib/logger";
import { withListingRatings } from "@/lib/ratings";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await withListingRatings(await db.select().from(products).orderBy(asc(products.id)));
  logger.info("listed products", { "products.count": rows.length });
  return Response.json(rows);
}
`,
  "src/db/client.ts": `import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type QueryResult } from "pg";
import { watchPool } from "./pool-watch";
import * as schema from "./schema";

export const DEFAULT_DATABASE_URL = "postgres://triage:triage@localhost:5433/shopfront";

type Stats = { queries: number; rows: number };

const globalForDb = globalThis as unknown as { shopfrontPool?: Pool; shopfrontQueryStats?: Stats };

// Reuse the pool across dev hot reloads.
export const pool =
  globalForDb.shopfrontPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 3000,
  });

if (process.env.NODE_ENV !== "production") globalForDb.shopfrontPool = pool;

watchPool(pool);

// Queries sent and rows they returned since the server started, for
// /api/health. Kept across hot reloads like the pool.
const stats = (globalForDb.shopfrontQueryStats ??= { queries: 0, rows: 0 });
export const queriesIssued = () => stats.queries;
export const rowsFetched = () => stats.rows;

// Drizzle sends its queries through pool.query; each result's rows are
// added up as it arrives. Wrapped once per pool, so a hot reload, which
// keeps the pool, doesn't wrap it again.
const counted = Symbol.for("shopfront.rowsCounted");
const marked = pool as Pool & { [counted]?: true };
if (!marked[counted]) {
  marked[counted] = true;
  const query = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  pool.query = ((...args: unknown[]) => {
    const result = query(...args);
    if (result instanceof Promise) {
      result.then(
        (r: QueryResult) => void (stats.rows += Array.isArray(r?.rows) ? r.rows.length : 0),
        () => undefined,
      );
    }
    return result;
  }) as typeof pool.query;
}

export const db = drizzle({
  client: pool,
  schema,
  logger: {
    logQuery() {
      stats.queries++;
    },
  },
});
`,
  "src/db/schema.ts": `import { sql } from "drizzle-orm";
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
    check("reviews_rating_range", sql\`\${t.rating} between 1 and 5\`),
  ],
);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
`,
  "src/db/seed.ts": `import { eq, notInArray, sql } from "drizzle-orm";
import { catalog, openingStock } from "@/lib/catalog";
import { syncListPrices } from "@/lib/prices";
import { db, pool } from "./client";
import { productPrices, products, reviews, stockLevels } from "./schema";

// Reviews written for each product. Stands in for a busy store's review
// history: years of orders, each one a chance of a review.
const REVIEWS_PER_PRODUCT = 50_000;

// What reviewers say, a phrase each.
const reviewPhrases = [
  "Lovely quality, just as pictured.",
  "Arrived quickly and well packed.",
  "Use it every day.",
  "Bought a second one as a gift.",
  "Even nicer in person.",
  "Good value for the price.",
  "Smaller than I expected, but well made.",
  "The colour is beautiful.",
  "Solid and well finished.",
  "Would buy again.",
];

// Rebuilds the reviews: REVIEWS_PER_PRODUCT for every product, dated over
// the last three years and rated 3 to 5 so each product's average lands
// near its catalog rating: 4% three stars, then the share of five stars
// that brings the average there, the rest four.
async function seedReviews() {
  await db.execute(sql\`truncate table \${reviews} restart identity\`);
  await db.execute(sql\`
    insert into \${reviews} (product_id, rating, body, created_at)
    select p.id,
           case
             when g.u < 0.04 then 3
             when g.u < 1 - least(0.96, greatest(0, p.rating_tenths / 10.0 - 3.96)) then 4
             else 5
           end,
           (\${sql.raw(\`array[\${reviewPhrases.map((p) => \`'\${p.replaceAll("'", "''")}'\`).join(", ")}]\`)})[1 + floor(g.v * \${reviewPhrases.length})::int],
           now() - g.w * interval '3 years'
      from \${products} p
     cross join lateral (
       select random() as u, random() as v, random() as w
         from generate_series(1, \${REVIEWS_PER_PRODUCT})
        where p.id is not null
     ) g\`);
  await db.execute(sql\`analyze \${reviews}\`);
}

// Makes the products table match the catalog: inserts new products, updates
// the ones that exist (by name), and removes products no longer in it, such
// as the placeholder apparel from before the store had a brand. Stock is
// reset to the opening levels each time, then the price list is synced and
// the reviews rebuilt.
async function main() {
  const names = catalog.map((p) => p.name);
  const removed = await db.delete(products).where(notInArray(products.name, names)).returning({ id: products.id });

  for (const { name, ...details } of catalog) {
    const [row] = await db
      .insert(products)
      .values({ name, ...details })
      .onConflictDoUpdate({ target: products.name, set: details })
      .returning({ id: products.id });
    const onHand = openingStock[name];
    if (onHand === undefined) {
      // Unstocked on purpose (see openingStock): no row.
      await db.delete(stockLevels).where(eq(stockLevels.productId, row.id));
      continue;
    }
    await db
      .insert(stockLevels)
      .values({ productId: row.id, onHand })
      .onConflictDoUpdate({ target: stockLevels.productId, set: { onHand, updatedAt: new Date() } });
  }

  // The price list is rebuilt from the catalog prices.
  await db.delete(productPrices);
  const priced = await syncListPrices();
  await seedReviews();
  console.log(
    \`seed: \${catalog.length} product(s) in the catalog, \${removed.length} removed, stock reset, \${priced.length} price(s) listed, \` +
      \`\${REVIEWS_PER_PRODUCT.toLocaleString("en-US")} review(s) each\`,
  );
}

main()
  .catch((err) => {
    console.error("seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
`,
  "src/lib/catalog.ts": `import type { NewProduct } from "@/db/schema";

// Fernhill Goods' catalog: everyday home and kitchen goods. The seed writes
// it to the database; the pages read the database, so a database outage
// shows as one (which is the point of this app).

export const categories = ["Kitchen", "Tableware", "Home", "Linen"] as const;
export type Category = (typeof categories)[number];

// What each category is about, for its tile on the home page.
export const categoryBlurbs: Record<Category, string> = {
  Kitchen: "Boards, jars and pots for cooking every day",
  Tableware: "Stoneware and glass for the table",
  Home: "Vases, candles and planters",
  Linen: "Washed linen for the kitchen and table",
};

export const catalog: NewProduct[] = [
  {
    name: "Stoneware Mug",
    category: "Tableware",
    priceCents: 2400,
    description: "A wide, heavy mug in matte glaze, thrown to sit well in both hands.",
    ratingTenths: 48,
    reviewCount: 214,
    art: "mug",
    tint: "sage",
  },
  {
    name: "Speckled Serving Bowl",
    category: "Tableware",
    priceCents: 4800,
    description: "A shallow bowl in speckled oatmeal glaze, for salads and shared plates.",
    ratingTenths: 47,
    reviewCount: 96,
    art: "bowl",
    tint: "sand",
  },
  {
    name: "Linen Tea Towel Set",
    category: "Linen",
    priceCents: 3200,
    description: "Two stonewashed linen towels that dry fast and soften with every wash.",
    ratingTenths: 46,
    reviewCount: 158,
    art: "towel",
    tint: "clay",
  },
  {
    name: "Olive Wood Cutting Board",
    category: "Kitchen",
    priceCents: 5800,
    description: "Cut from a single piece of olive wood, oiled and ready to use.",
    ratingTenths: 49,
    reviewCount: 73,
    art: "board",
    tint: "sand",
  },
  {
    name: "Hand-thrown Bud Vase",
    category: "Home",
    priceCents: 3600,
    description: "A small vase for a single stem, each one slightly different.",
    ratingTenths: 47,
    reviewCount: 41,
    art: "vase",
    tint: "sky",
  },
  {
    name: "Beeswax Pillar Candle",
    category: "Home",
    priceCents: 2200,
    description: "Pure beeswax, hand-poured, burns clean for about 40 hours.",
    ratingTenths: 45,
    reviewCount: 187,
    art: "candle",
    tint: "honey",
  },
  {
    name: "Glass Storage Jar",
    category: "Kitchen",
    priceCents: 1800,
    description: "Borosilicate glass with an oak lid, for grains, coffee and tea.",
    ratingTenths: 44,
    reviewCount: 129,
    art: "jar",
    tint: "sky",
  },
  {
    name: "Ceramic Dinner Plates, Set of 2",
    category: "Tableware",
    priceCents: 4200,
    description: "Everyday plates with a raw rim, safe in the dishwasher and oven.",
    ratingTenths: 46,
    reviewCount: 88,
    art: "plate",
    tint: "sage",
  },
  {
    name: "Cast Iron Teapot",
    category: "Kitchen",
    priceCents: 7800,
    description: "Enamelled inside, with a stainless infuser. Keeps tea hot for an hour.",
    ratingTenths: 48,
    reviewCount: 64,
    art: "teapot",
    tint: "clay",
  },
  {
    name: "Ribbed Drinking Glasses, Set of 4",
    category: "Tableware",
    priceCents: 3400,
    description: "Thin, ribbed tumblers for water and juice, stackable.",
    ratingTenths: 45,
    reviewCount: 112,
    art: "glass",
    tint: "sky",
  },
  {
    name: "Linen Napkins, Set of 4",
    category: "Linen",
    priceCents: 2800,
    description: "Washed linen napkins in a soft, lived-in weave.",
    ratingTenths: 47,
    reviewCount: 69,
    art: "napkin",
    tint: "sage",
  },
  {
    name: "Terracotta Planter",
    category: "Home",
    priceCents: 3000,
    description: "Unglazed terracotta with a drainage hole and matching saucer.",
    ratingTenths: 46,
    reviewCount: 52,
    art: "planter",
    tint: "clay",
  },
  // New arrivals (see newArrivals below).
  {
    name: "Stoneware Pasta Bowls, Set of 2",
    category: "Tableware",
    priceCents: 5200,
    description: "Wide, low bowls in a glossy sage glaze, deep enough for soup and broad enough for pasta.",
    ratingTenths: 49,
    reviewCount: 38,
    art: "bowl",
    tint: "sage",
  },
  {
    name: "Linen Apron",
    category: "Linen",
    priceCents: 4600,
    description: "A full-length apron in heavy washed linen, with a deep front pocket and long ties.",
    ratingTenths: 47,
    reviewCount: 27,
    art: "towel",
    tint: "sand",
  },
  {
    name: "Ribbed Ceramic Vase",
    category: "Home",
    priceCents: 6400,
    description: "A tall vase with a hand-carved ribbed body, glazed inside to hold water.",
    ratingTenths: 48,
    reviewCount: 19,
    art: "vase",
    tint: "clay",
  },
];

// Just in from our makers, featured on the home page. Their first delivery
// hasn't been counted into stock yet, so they show as sold out until it is.
export const newArrivals = ["Stoneware Pasta Bowls, Set of 2", "Linen Apron", "Ribbed Ceramic Vase"];

// Units on hand when seeded, by product name. A spread on purpose: plenty,
// a few left, and one sold out, so every buy box state is on the shelf.
// The Cast Iron Teapot and the new arrivals are left out: they have no stock
// row yet, which shows as sold out.
export const openingStock: Record<string, number> = {
  "Stoneware Mug": 64,
  "Speckled Serving Bowl": 18,
  "Linen Tea Towel Set": 41,
  "Olive Wood Cutting Board": 3,
  "Hand-thrown Bud Vase": 7,
  "Beeswax Pillar Candle": 120,
  "Glass Storage Jar": 85,
  "Ceramic Dinner Plates, Set of 2": 26,
  "Ribbed Drinking Glasses, Set of 4": 52,
  "Linen Napkins, Set of 4": 2,
  "Terracotta Planter": 33,
};

// What the pieces in each category are made of and how to look after them,
// for the product page's details.
export const categoryDetails: Record<Category, { materials: string; care: string }> = {
  Kitchen: {
    materials: "Wood, glass and cast iron from small workshops in Europe.",
    care: "Hand wash and dry straight away. Oil wooden pieces once a month.",
  },
  Tableware: {
    materials: "High-fired stoneware and soda-lime glass.",
    care: "Dishwasher and microwave safe. Avoid sudden changes in temperature.",
  },
  Home: {
    materials: "Hand-thrown ceramic, terracotta and pure beeswax.",
    care: "Wipe clean with a soft, damp cloth. Trim candle wicks to 5 mm.",
  },
  Linen: {
    materials: "100% European flax linen, stonewashed.",
    care: "Machine wash at 40°C, tumble dry low. Softens with every wash.",
  },
};

export const formatPrice = (cents: number) => \`$\${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}\`;
`,
  "src/lib/flags.ts": `// Feature flags for gradual rollouts. Each starts from its env var ("1" or
// "true" turns it on) and can be flipped at runtime without a restart. Kept
// in memory, not the database, so a flag still answers when the database
// doesn't.

export const featureFlags = {
  FF_STOCK_DIRECT_QUERY: {
    label: "Direct stock query",
    description: "Read stock levels with a hand-written query on a pooled client instead of through Drizzle.",
  },
  FF_LIST_PRICES: {
    label: "List prices",
    description: "Serve prices on the product page, the product API and the cart from the price list instead of the catalog.",
  },
  FF_LIVE_RATINGS: {
    label: "Live ratings",
    description: "Show star ratings on the home page, category and search listings and the product list API averaged from the reviews instead of the stored rating.",
  },
} as const;

export type FeatureFlag = keyof typeof featureFlags;

const fromEnv = (name: FeatureFlag) => ["1", "true"].includes((process.env[name] ?? "").toLowerCase());

// On globalThis so dev hot reloads keep what was switched at runtime.
const globalForFlags = globalThis as unknown as { shopfrontFlags?: Partial<Record<FeatureFlag, boolean>> };
const overrides = (globalForFlags.shopfrontFlags ??= {});

export const isEnabled = (name: FeatureFlag) => overrides[name] ?? fromEnv(name);

export function setFlag(name: FeatureFlag, on: boolean) {
  overrides[name] = on;
}

export const flagStates = () =>
  (Object.keys(featureFlags) as FeatureFlag[]).map((name) => ({ name, ...featureFlags[name], enabled: isEnabled(name) }));
`,
  "src/lib/logger.ts": `import { logs, SeverityNumber, type Attributes } from "@opentelemetry/api";

// In OTel JS SDK 3.x the Logs API lives in @opentelemetry/api (the separate
// @opentelemetry/api-logs package is the pre-3.0 line). Records emitted here
// pick up the active span context, so logs correlate with traces.
const otelLogger = logs.getLogger("shopfront");

type Level = "debug" | "info" | "warn" | "error";

const severity: Record<Level, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

function emit(level: Level, message: string, attributes?: Attributes) {
  otelLogger.emit({
    severityNumber: severity[level],
    severityText: level.toUpperCase(),
    body: message,
    attributes,
  });
  const line = attributes ? \`\${message} \${JSON.stringify(attributes)}\` : message;
  console[level === "debug" ? "log" : level](\`[\${level}] \${line}\`);
}

export const logger = {
  debug: (msg: string, attrs?: Attributes) => emit("debug", msg, attrs),
  info: (msg: string, attrs?: Attributes) => emit("info", msg, attrs),
  warn: (msg: string, attrs?: Attributes) => emit("warn", msg, attrs),
  error: (msg: string, attrs?: Attributes) => emit("error", msg, attrs),
};
`,
  "src/lib/money.ts": `// Prices are stored in cents. The store's currency comes from the
// deployment (STORE_CURRENCY) rather than the catalog, so the same products
// can be sold in another region without a data change.
export function formatPrice(cents: number, currency = process.env.STORE_CURRENCY): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}
`,
  "src/lib/prices.ts": `import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { productPrices, products, stockLevels, type Product } from "@/db/schema";
import { isEnabled } from "@/lib/flags";

// Copies catalog prices into the price list, adding new products and
// updating changed prices. Only products we sell get a list price, so it
// takes the products inventory carries.
export async function syncListPrices() {
  return db
    .insert(productPrices)
    .select(
      db
        .select({ productId: products.id, amountCents: products.priceCents, updatedAt: sql\`now()\`.as("updated_at") })
        .from(products)
        .innerJoin(stockLevels, eq(stockLevels.productId, products.id)),
    )
    .onConflictDoUpdate({
      target: productPrices.productId,
      set: { amountCents: sql\`excluded.amount_cents\`, updatedAt: sql\`now()\` },
    })
    .returning({ productId: productPrices.productId });
}

// One product's price from the price list.
export async function getListPrice(productId: number): Promise<number> {
  const [{ amountCents }] = await db
    .select({ amountCents: productPrices.amountCents })
    .from(productPrices)
    .where(eq(productPrices.productId, productId))
    .limit(1);
  return amountCents;
}

// What a product sells for. FF_LIST_PRICES moves the product page, the
// product API and the cart over to the price list; listings keep the
// catalog price until it's rolled out.
export async function priceOf(product: Pick<Product, "id" | "priceCents">): Promise<number> {
  return isEnabled("FF_LIST_PRICES") ? getListPrice(product.id) : product.priceCents;
}
`,
  "src/lib/products.ts": `import { and, asc, eq, ne } from "drizzle-orm";
import { cache } from "react";
import { db } from "@/db/client";
import { products } from "@/db/schema";

// Parses a route's id segment; anything but a positive integer is no product.
export const parseProductId = (raw: string) => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

// Cached per request, so the page and its metadata share one query.
export const getProduct = cache(async (id: number) => {
  const [row] = await db.select().from(products).where(eq(products.id, id)).limit(1);
  return row ?? null;
});

export async function getRelated(category: string, excludeId: number, limit = 4) {
  return db
    .select()
    .from(products)
    .where(and(eq(products.category, category), ne(products.id, excludeId)))
    .orderBy(asc(products.id))
    .limit(limit);
}
`,
  "src/lib/ratings.ts": `import { eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { products, reviews } from "@/db/schema";
import { isEnabled } from "@/lib/flags";

export type ListingRating = { ratingTenths: number; reviewCount: number };

// The star rating and review count each listed product shows. Live ratings
// (FF_LIVE_RATINGS) average the product's reviews on each listing, so new
// reviews show at once, rather than waiting for the stored rating_tenths
// and review_count to be updated. Off, listings show the stored ones.
export async function getListingRatings(productIds: number[]): Promise<Map<number, ListingRating>> {
  const ratings = new Map<number, ListingRating>();
  if (productIds.length === 0) return ratings;

  if (!isEnabled("FF_LIVE_RATINGS")) {
    const rows = await db
      .select({ id: products.id, ratingTenths: products.ratingTenths, reviewCount: products.reviewCount })
      .from(products)
      .where(inArray(products.id, productIds));
    for (const { id, ...rating } of rows) ratings.set(id, rating);
    return ratings;
  }

  for (const id of productIds) {
    const rows = await db.select({ rating: reviews.rating }).from(reviews).where(eq(reviews.productId, id));
    const total = rows.reduce((sum, r) => sum + r.rating, 0);
    ratings.set(id, {
      ratingTenths: rows.length ? Math.round((total / rows.length) * 10) : 0,
      reviewCount: rows.length,
    });
  }
  return ratings;
}

// Product rows with the rating their listing shows. A product with no
// rating to show keeps the one it has.
export async function withListingRatings<T extends { id: number } & ListingRating>(rows: T[]): Promise<T[]> {
  const ratings = await getListingRatings(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, ...ratings.get(r.id) }));
}
`,
  "src/lib/stock.ts": `import { eq } from "drizzle-orm";
import { db, pool } from "@/db/client";
import { stockLevels } from "@/db/schema";
import { isEnabled } from "@/lib/flags";
import { logger } from "@/lib/logger";

// Below this many units the buy box says how many are left.
export const LOW_STOCK = 10;

// A product with no stock row hasn't been stocked yet: it shows as sold out
// rather than as an error.
const DEFAULT_STOCK = 0;

export type StockStatus = "in_stock" | "low" | "sold_out";

export const stockStatus = (onHand: number): StockStatus =>
  onHand <= 0 ? "sold_out" : onHand < LOW_STOCK ? "low" : "in_stock";

// Units on hand for one product. Product pages call this on every view, so
// FF_STOCK_DIRECT_QUERY trials a leaner query for it.
export async function getStockLevel(productId: number): Promise<number> {
  return isEnabled("FF_STOCK_DIRECT_QUERY") ? getStockLevelDirect(productId) : getStockLevelOrm(productId);
}

async function getStockLevelOrm(productId: number): Promise<number> {
  const [row] = await db
    .select({ onHand: stockLevels.onHand })
    .from(stockLevels)
    .where(eq(stockLevels.productId, productId))
    .limit(1);
  if (!row) {
    logger.info("stock row missing, returning default", { "product.id": productId });
    return DEFAULT_STOCK;
  }
  return row.onHand;
}

// One parameterised query on a pooled client, skipping Drizzle's query
// building.
async function getStockLevelDirect(productId: number): Promise<number> {
  const client = await pool.connect();
  const { rows } = await client.query<{ on_hand: number }>(
    "SELECT on_hand FROM stock_levels WHERE product_id = $1",
    [productId],
  );
  if (rows.length === 0) {
    logger.info("stock row missing, returning default", { "product.id": productId });
    return DEFAULT_STOCK;
  }
  client.release();
  return rows[0].on_hand;
}
`,
};
