// Generated from apps/shopfront at 65717f0 with the live ratings change
// (not yet committed): the files the live-ratings scenario serves,
// verbatim. Regenerate rather than edit, so the scenario keeps matching the
// store.

export const liveRatingsFiles: Record<string, string> = {
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
  "src/app/(store)/page.tsx": `import { and, asc, eq, ilike, inArray, type SQL } from "drizzle-orm";
import { ArrowRight, Leaf, RotateCcw, Truck } from "lucide-react";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { ProductImage } from "@/components/product-image";
import { ProductCard } from "@/components/product-card";
import { Button } from "@/components/ui/button";
import { db } from "@/db/client";
import { products, type Product } from "@/db/schema";
import { catalog, categories, categoryBlurbs, newArrivals, type Category } from "@/lib/catalog";
import { logger } from "@/lib/logger";
import { withListingRatings } from "@/lib/ratings";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Search = { category?: string | string[]; q?: string | string[] };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

// The pictures on the hero and category tiles come from the catalog, not the
// database, so they still render when the database is down. Only the grid
// depends on it.
const pictured = (name: string) => catalog.find((p) => p.name === name)!;
const heroArt = [pictured("Stoneware Mug"), pictured("Hand-thrown Bud Vase"), pictured("Olive Wood Cutting Board")];
const categoryArt = Object.fromEntries(
  categories.map((c) => [c, catalog.find((p) => p.category === c)!]),
) as Record<Category, (typeof catalog)[number]>;

async function loadProducts(category: Category | undefined, q: string | undefined) {
  const where: SQL[] = [];
  if (category) where.push(eq(products.category, category));
  if (q) where.push(ilike(products.name, \`%\${q.replace(/[%_\\\\]/g, "\\\\$&")}%\`));
  try {
    const rows = await withListingRatings(
      await db
        .select()
        .from(products)
        .where(and(...where))
        .orderBy(asc(products.id)),
    );
    return { rows, error: false as const };
  } catch (err) {
    logger.error("home: failed to load products", { "error.message": String(err) });
    return { rows: [] as Product[], error: true as const };
  }
}

export default async function Home({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const requested = first(params.category);
  const category = categories.find((c) => c === requested);
  const q = first(params.q);

  // Only the grid waits on the database: the rest renders at once, and the
  // grid streams in behind a skeleton (for 3 s when the pool is jammed).
  return (
    <>
      <Hero />
      <Suspense>
        <NewArrivals />
      </Suspense>
      <CategoryTiles />
      <section id="shop" aria-labelledby="shop-title" className="mx-auto max-w-6xl scroll-mt-32 px-4 pt-20 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 id="shop-title" className="font-serif text-3xl font-semibold tracking-tight">
            {q ? \`Results for “\${q}”\` : (category ?? "All products")}
          </h2>
          <CategoryFilter active={category} q={q} />
        </div>
        <Suspense key={\`\${category}|\${q}\`} fallback={<GridSkeleton />}>
          <ProductResults category={category} q={q} />
        </Suspense>
      </section>
    </>
  );
}

async function ProductResults({ category, q }: { category: Category | undefined; q: string | undefined }) {
  const { rows, error } = await loadProducts(category, q);
  return (
    <>
      {!error && (
        <p className="mt-4 text-sm text-muted-foreground">
          {rows.length} {rows.length === 1 ? "product" : "products"}
          {q && category ? \` in \${category}\` : ""}
        </p>
      )}
      {error ? (
          <Notice title="We can't show products right now">
            Something went wrong on our side. Please try again in a minute.
          </Notice>
        ) : rows.length === 0 ? (
          <Notice title={q ? "No products match your search" : "Nothing here yet"}>
            {q ? "Try a different word, or browse everything." : "Check back soon."}{" "}
            <Link href="/#shop" className="font-medium text-primary underline-offset-4 hover:underline">
              See all products
            </Link>
          </Notice>
        ) : (
          <ul className="mt-6 grid grid-cols-2 gap-x-4 gap-y-10 sm:gap-x-6 lg:grid-cols-4">
            {rows.map((p, i) => (
              <li
                key={p.id}
                className="animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-backwards duration-500 motion-reduce:animate-none"
                style={{ animationDelay: \`\${Math.min(i, 8) * 40}ms\` }}
              >
                <ProductCard product={p} />
              </li>
            ))}
          </ul>
        )}
    </>
  );
}

// The latest products, in catalog order. A nice-to-have above the fold, so
// if it can't load the row is left out and the page carries on.
async function NewArrivals() {
  const rows = await db
    .select()
    .from(products)
    .where(inArray(products.name, newArrivals))
    .orderBy(asc(products.id))
    .then(withListingRatings)
    .catch((err) => {
      logger.error("home: failed to load new arrivals", { "error.message": String(err) });
      return [] as Product[];
    });
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="new-arrivals-title" className="mx-auto max-w-6xl px-4 pt-20 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h2 id="new-arrivals-title" className="font-serif text-2xl font-semibold tracking-tight">
          New arrivals
        </h2>
        <p className="text-sm text-muted-foreground">Just in from our makers</p>
      </div>
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

function GridSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading products">
      <div className="mt-4 h-5 w-24 animate-pulse rounded bg-secondary" />
      <ul className="mt-6 grid grid-cols-2 gap-x-4 gap-y-10 sm:gap-x-6 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <li key={i}>
            <div className="aspect-square animate-pulse rounded-lg bg-secondary" />
            <div className="mt-3 h-4 w-3/4 animate-pulse rounded bg-secondary" />
            <div className="mt-2 h-3 w-1/3 animate-pulse rounded bg-secondary" />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Hero() {
  return (
    <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 pt-10 sm:px-6 md:grid-cols-2 md:pt-16">
      <div>
        <p className="text-sm font-medium text-primary">New this autumn: stoneware in sage and clay</p>
        <h1 className="mt-3 font-serif text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">
          Everyday goods, made to last.
        </h1>
        <p className="mt-5 max-w-md text-base text-muted-foreground text-pretty">
          Stoneware, linen, wood and glass for the kitchen and table, from small workshops that make things slowly
          and well.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button size="lg" asChild className="h-11 px-5">
            <Link href="/#shop">
              Shop all <ArrowRight data-icon="inline-end" />
            </Link>
          </Button>
          <Button size="lg" variant="outline" asChild className="h-11 bg-card px-5">
            <Link href="/?category=Tableware#shop">Shop tableware</Link>
          </Button>
        </div>
        <ul className="mt-10 flex flex-wrap gap-x-6 gap-y-3 text-sm text-muted-foreground">
          <li className="flex items-center gap-2">
            <Truck className="size-4 text-primary" /> Free shipping over $75
          </li>
          <li className="flex items-center gap-2">
            <RotateCcw className="size-4 text-primary" /> 30-day returns
          </li>
          <li className="flex items-center gap-2">
            <Leaf className="size-4 text-primary" /> Natural materials
          </li>
        </ul>
      </div>
      {/* The small tiles are square; the large one stretches over both rows. */}
      <div className="grid grid-cols-5 grid-rows-2 gap-3 sm:gap-4" aria-hidden="true">
        <div className="col-span-3 row-span-2 overflow-hidden rounded-xl">
          <ProductImage name={heroArt[0].name} art={heroArt[0].art!} tint={heroArt[0].tint!} sizes="(min-width: 768px) 30vw, 60vw" preload />
        </div>
        <div className="col-span-2 aspect-square overflow-hidden rounded-xl">
          <ProductImage name={heroArt[1].name} art={heroArt[1].art!} tint={heroArt[1].tint!} sizes="(min-width: 768px) 20vw, 40vw" preload />
        </div>
        <div className="col-span-2 aspect-square overflow-hidden rounded-xl">
          <ProductImage name={heroArt[2].name} art={heroArt[2].art!} tint={heroArt[2].tint!} sizes="(min-width: 768px) 20vw, 40vw" preload />
        </div>
      </div>
    </section>
  );
}

function CategoryTiles() {
  return (
    <section aria-labelledby="categories-title" className="mx-auto max-w-6xl px-4 pt-20 sm:px-6">
      <h2 id="categories-title" className="font-serif text-2xl font-semibold tracking-tight">
        Shop by category
      </h2>
      <ul className="mt-6 grid grid-cols-2 gap-4 sm:gap-6 lg:grid-cols-4">
        {categories.map((c) => {
          const art = categoryArt[c];
          return (
            <li key={c}>
              <Link
                href={\`/?category=\${encodeURIComponent(c)}#shop\`}
                className="group block rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
              >
                <div className="aspect-[4/3] overflow-hidden rounded-lg">
                  <ProductImage
                    name={art.name}
                    art={art.art!}
                    sizes="(min-width: 1024px) 25vw, 50vw"
                    tint={art.tint!}
                    className="h-full w-full transition-transform duration-500 ease-out group-hover:scale-[1.04] motion-reduce:transition-none"
                  />
                </div>
                <p className="mt-3 flex items-center gap-1 font-medium">
                  {c}
                  <ArrowRight className="size-4 -translate-x-1 opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100 motion-reduce:transition-none" />
                </p>
                <p className="mt-0.5 text-sm text-muted-foreground">{categoryBlurbs[c]}</p>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CategoryFilter({ active, q }: { active: Category | undefined; q: string | undefined }) {
  const href = (c?: Category) => {
    const sp = new URLSearchParams();
    if (c) sp.set("category", c);
    if (q) sp.set("q", q);
    const s = sp.toString();
    return \`/\${s ? \`?\${s}\` : ""}#shop\`;
  };
  const options: { label: string; value?: Category }[] = [{ label: "All" }, ...categories.map((c) => ({ label: c, value: c }))];
  // Phones: one scrolling row, edge to edge, instead of wrapping.
  return (
    <nav
      aria-label="Filter by category"
      className="-mx-4 w-[calc(100%+2rem)] overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:w-auto sm:px-0"
    >
      <ul className="flex gap-2 sm:flex-wrap">
        {options.map((o) => {
          const current = o.value === active;
          return (
            <li key={o.label} className="shrink-0">
              <Link
                href={href(o.value)}
                scroll={false}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "inline-flex h-8 items-center rounded-full border px-3.5 text-sm transition-colors",
                  current
                    ? "border-foreground bg-foreground text-background"
                    : "bg-card text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                )}
              >
                {o.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div role="status" className="mt-8 rounded-xl border border-dashed bg-card px-6 py-16 text-center">
      <p className="font-serif text-xl font-semibold">{title}</p>
      <p className="mt-2 text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
`,
  "src/app/api/health/route.ts": `import { sql } from "drizzle-orm";
import { db, pool, queriesIssued, rowsFetched } from "@/db/client";
import { flagStates } from "@/lib/flags";

export const dynamic = "force-dynamic";

// pool: the pg pool's own counts, read before the probe query so they show
// the state that query met. If the pool runs out, \`checkedOut\` sits at \`max\`
// and \`waiting\` climbs while the probe times out. queries and rows: how
// many queries the app has sent since it started, and the rows they
// returned, this probe included.
export async function GET() {
  const counts = {
    max: pool.options.max,
    total: pool.totalCount,
    idle: pool.idleCount,
    checkedOut: pool.totalCount - pool.idleCount,
    waiting: pool.waitingCount,
  };
  let dbOk = false;
  try {
    await db.execute(sql\`select 1\`);
    dbOk = true;
  } catch {
    dbOk = false;
  }
  const flags = Object.fromEntries(flagStates().map((f) => [f.name, f.enabled]));
  return Response.json(
    { ok: dbOk, db: dbOk, pool: counts, queries: queriesIssued(), rows: rowsFetched(), flags },
    { status: dbOk ? 200 : 503 },
  );
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
  "src/components/product-card.tsx": `import { Star } from "lucide-react";
import Link from "next/link";
import type { Product } from "@/db/schema";
import { formatPrice } from "@/lib/catalog";
import { Badge } from "./ui/badge";
import { ProductImage } from "./product-image";

// Enough reviews to call it a bestseller in a catalog this size.
const BESTSELLER_REVIEWS = 150;

export function ProductCard({ product }: { product: Product }) {
  const rating = (product.ratingTenths / 10).toFixed(1);
  return (
    <Link href={\`/products/\${product.id}\`} className="group block rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/40">
      <div className="relative aspect-square overflow-hidden rounded-lg bg-secondary">
        <ProductImage
          name={product.name}
          art={product.art}
          sizes="(min-width: 1024px) 25vw, 50vw"
          tint={product.tint}
          className="transition-transform duration-500 ease-out group-hover:scale-[1.04] motion-reduce:transition-none"
        />
        {product.reviewCount >= BESTSELLER_REVIEWS && (
          <Badge variant="secondary" className="absolute top-3 left-3 bg-card/90 backdrop-blur">
            Bestseller
          </Badge>
        )}
      </div>
      <div className="mt-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium leading-snug group-hover:underline group-hover:underline-offset-4">
            {product.name}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{product.category}</p>
        </div>
        <p className="text-sm font-medium tabular-nums">{formatPrice(product.priceCents)}</p>
      </div>
      <p className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
        <Star className="size-3.5 fill-star text-star" aria-hidden="true" />
        <span className="sr-only">Rated</span>
        <span className="font-medium text-foreground tabular-nums">{rating}</span>
        <span className="sr-only">out of 5,</span>
        <span className="tabular-nums">({product.reviewCount.toLocaleString("en-US")})</span>
        <span className="sr-only">reviews</span>
      </p>
    </Link>
  );
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
};
