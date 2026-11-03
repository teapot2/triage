// Generated from apps/shopfront at 417b767 (the release the traffic-rush
// scenario records: "chore(shopfront): reword the journal page intro"): the
// files the scenario serves, verbatim. Regenerate rather than edit, so the
// scenario keeps matching the release.

export const trafficRushFiles: Record<string, string> = {
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
  "src/app/(store)/journal/page.tsx": `import type { Metadata } from "next";
import { InfoPage, InfoSectionBlock } from "@/components/info-page";

export const metadata: Metadata = { title: "Journal" };

// Short notes, newest first, kept whole on one page.
const posts = [
  {
    title: "New this autumn: sage and clay",
    date: "October 2026",
    body: [
      "Alder & Ash spent the summer testing glazes, and two made the cut: a soft sage green and a warm, iron-flecked clay. Both are on the mug, the serving bowl and the dinner plates now.",
      "Because each piece is glazed by hand, the color pools a little darker where the glaze runs thick. The photos show the range; yours will be somewhere in it.",
    ],
  },
  {
    title: "How we pack a mug",
    date: "August 2026",
    body: [
      "Stoneware travels badly in loose fill, so we stopped using it. Every piece now goes into a molded pulp sleeve that holds it off the walls of the box, and the box goes into a second one.",
      "No plastic anywhere: the sleeves, the boxes and the paper tape all go in the recycling, and the sleeves compost.",
    ],
  },
  {
    title: "A visit to the olive groves",
    date: "May 2026",
    body: [
      "We spent a week in Jaén with Olivar Woodworks during pruning season. The branches cut to keep the trees fruiting are the ones that become boards; the trunks of old trees taken out of production make the big ones.",
      "It takes about a year for the wood to dry before it can be cut, which is why we can only order a few hundred boards at a time.",
    ],
  },
  {
    title: "Why we wash linen before it ships",
    date: "February 2026",
    body: [
      "New linen is stiff and a little shiny. Saltmarsh stonewashes every towel and napkin, which softens the fibers and pre-shrinks them, so what you buy is the size it will stay.",
      "It also means the creases you see are the real thing. Linen wrinkles; we've learned to like it.",
    ],
  },
];

export default function JournalPage() {
  return (
    <InfoPage
      section="Company"
      current="/journal"
      title="Journal"
      intro="Notes from the studio and our makers' workshops: new pieces, how they are made, and the occasional visit to where they come from."
    >
      {posts.map((p) => (
        <InfoSectionBlock key={p.title} title={p.title} aside={p.date}>
          {p.body.map((para) => (
            <p key={para}>{para}</p>
          ))}
        </InfoSectionBlock>
      ))}
    </InfoPage>
  );
}
`,
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
    if (q) logger.info("catalog: searched", { "search.term": q.slice(0, 80), "products.count": rows.length });
    else logger.debug("catalog: listed", { "products.category": category ?? "all", "products.count": rows.length });
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
  "src/app/(store)/products/[id]/loading.tsx": ``,
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

// No loading.tsx for this route: it would stream the page shell before the
// product lookup, and a missing product would then answer 200 with the
// not-found view inside. Waiting for the lookup keeps the 404 a real one;
// the buy box and related products still stream in after it.
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
  "src/app/api/products/[id]/route.ts": `import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { products } from "@/db/schema";
import { logger } from "@/lib/logger";
import { priceOf } from "@/lib/prices";
import { parseProductId } from "@/lib/products";
import { getStockLevel } from "@/lib/stock";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await ctx.params;
  const id = parseProductId(rawId);
  if (id === null) {
    logger.warn("products: rejected id", { "product.id.raw": rawId.slice(0, 40) });
    return Response.json({ error: "invalid id" }, { status: 400 });
  }

  const [product] = await db.select().from(products).where(eq(products.id, id)).limit(1);
  logger.debug("fetched product", { "product.id": id, "product.found": Boolean(product) });

  if (!product) return Response.json({ error: "not found" }, { status: 404 });
  const priceCents = await priceOf(product);
  const stock = await getStockLevel(product.id);
  return Response.json({ ...product, priceCents, stock });
}
`,
  "src/app/api/products/route.ts": `import { asc } from "drizzle-orm";
import { db } from "@/db/client";
import { products } from "@/db/schema";
import { logger } from "@/lib/logger";
import { withListingRatings } from "@/lib/ratings";

export const dynamic = "force-dynamic";

export async function GET() {
  const started = performance.now();
  const rows = await withListingRatings(await db.select().from(products).orderBy(asc(products.id)));
  logger.debug("listed products", { "products.count": rows.length, duration_ms: Math.round(performance.now() - started) });
  return Response.json(rows);
}
`,
  "src/components/info-page.tsx": `import Link from "next/link";
import type { ReactNode } from "react";
import { infoSections, type InfoSection } from "@/lib/info-pages";
import { cn } from "@/lib/utils";

// The frame for the help and company pages: a title and intro, the page's
// sections, and the other pages in the same group beside them. Static, so
// these pages render with or without the database.
export function InfoPage({
  section,
  current,
  title,
  intro,
  children,
}: {
  section: InfoSection;
  current: string;
  title: string;
  intro: ReactNode;
  children: ReactNode;
}) {
  const group = infoSections.find((s) => s.title === section)!;
  return (
    <div className="mx-auto grid max-w-6xl gap-10 px-4 pt-10 sm:px-6 md:grid-cols-[12rem_1fr] md:gap-16 md:pt-16">
      <nav aria-label={section} className="max-md:order-last max-md:border-t max-md:pt-8">
        <p className="text-sm font-medium">{section}</p>
        <ul className="mt-3 space-y-1 text-sm">
          {group.links.map((l) => (
            <li key={l.href}>
              <Link
                href={l.href}
                aria-current={l.href === current ? "page" : undefined}
                className={cn(
                  "-mx-2 block rounded-md px-2 py-1.5 transition-colors",
                  l.href === current
                    ? "bg-secondary font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <article className="max-w-2xl">
        <h1 className="font-serif text-4xl font-semibold tracking-tight text-balance">{title}</h1>
        <div className="mt-4 text-lg text-muted-foreground text-pretty">{intro}</div>
        <div className="mt-10 space-y-12">{children}</div>
      </article>
    </div>
  );
}

export function InfoSectionBlock({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="font-serif text-2xl font-semibold tracking-tight">{title}</h2>
        {aside && <p className="text-sm text-muted-foreground">{aside}</p>}
      </div>
      <div className="mt-3 space-y-3 leading-relaxed text-pretty text-muted-foreground [&_li]:pl-1 [&_strong]:font-medium [&_strong]:text-foreground [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5">
        {children}
      </div>
    </section>
  );
}

// Label and value pairs, for prices and terms.
export function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="divide-y rounded-xl border bg-card">
      {items.map(([label, value]) => (
        <div key={label} className="flex flex-wrap justify-between gap-x-6 gap-y-1 px-4 py-3 text-sm">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="font-medium text-foreground tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
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
import { logger } from "@/lib/logger";
import { watchPool } from "./pool-watch";
import * as schema from "./schema";

export const DEFAULT_DATABASE_URL = "postgres://triage:triage@localhost:5433/shopfront";

type Stats = { queries: number; rows: number };

const globalForDb = globalThis as unknown as { shopfrontPool?: Pool; shopfrontQueryStats?: Stats };

function createPool() {
  const created = new Pool({
    connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 3000,
  });
  // Build workers open pools too, to collect page data; only the server's counts.
  if (process.env.NEXT_PHASE !== "phase-production-build") {
    logger.info("db: pool created", { "db.pool.max": created.options.max, "db.pool.connect_timeout_ms": created.options.connectionTimeoutMillis });
  }
  // An idle client the server dropped; the pool replaces it, so this is
  // worth knowing about but not fatal.
  created.on("error", (err) => logger.error("db: idle client error", { "error.message": err.message }));
  return created;
}

// One pool per process: shared across dev hot reloads, and between the
// server's bundles in production (the instrumentation hook and the routes
// load this module separately).
export const pool = globalForDb.shopfrontPool ?? createPool();
globalForDb.shopfrontPool = pool;

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
  "src/lib/access-log.ts": `import { context as otelContext, SpanKind, trace } from "@opentelemetry/api";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace";
import { logAt } from "./logger";

// The access log: one line per request, the way a web server writes one,
// taken from Next.js's own request spans so pages and API routes are
// covered alike without touching either. Each line carries the route, the
// path, the status and how long the request took, and is tied to its trace.
// Requests past SLOW_MS also get a warning, the usual trigger for a look.

export const SLOW_MS = 1000;

// Operator pages aren't customer traffic, so they stay out of the access log.
const internal = ["/ops", "/api/ops"];

const isRequest = (span: ReadableSpan) =>
  span.instrumentationScope.name === "next.js" && span.kind === SpanKind.SERVER && typeof span.attributes["http.route"] === "string";

const toMs = ([seconds, nanos]: [number, number]) => seconds * 1000 + nanos / 1e6;

export function accessLogProcessor(): SpanProcessor {
  return {
    onStart() {},
    onEnd(span) {
      if (!isRequest(span)) return;
      const route = String(span.attributes["http.route"]);
      if (internal.includes(route)) return;
      const method = String(span.attributes["http.method"] ?? "GET");
      const status = Number(span.attributes["http.status_code"] ?? 0);
      const durationMs = Math.round(toMs(span.duration) * 10) / 10;
      const attributes = {
        "http.request.method": method,
        "http.route": route,
        "http.response.status_code": status,
        "url.path": String(span.attributes["http.target"] ?? route),
        duration_ms: durationMs,
      };
      const options = {
        context: trace.setSpanContext(otelContext.active(), span.spanContext()),
        timestamp: toMs(span.endTime),
      };
      logAt(status >= 500 ? "error" : "info", \`\${method} \${route} \${status}\`, attributes, options);
      if (durationMs >= SLOW_MS) logAt("warn", "slow request", attributes, options);
    },
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
}
`,
  "src/lib/cart.ts": `import { cookies } from "next/headers";
import { MAX_LINES, MAX_PER_LINE } from "./cart-rules";
import { logger } from "./logger";

// The cart lives in a cookie: product ids and quantities only, so prices
// and names always come fresh from the database. No accounts, nothing
// stored server-side, and the server can render the header count on first
// paint.

export type CartLine = { productId: number; quantity: number };

const COOKIE = "cart";
const THIRTY_DAYS = 60 * 60 * 24 * 30;

const isCount = (n: unknown, max: number): n is number => Number.isInteger(n) && (n as number) > 0 && (n as number) <= max;

// Stored as [[id, qty], ...]. Anything malformed is dropped, not trusted.
export function parseCart(raw: string | undefined): CartLine[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (entry): entry is [number, number] =>
          Array.isArray(entry) && isCount(entry[0], Number.MAX_SAFE_INTEGER) && isCount(entry[1], MAX_PER_LINE),
      )
      .slice(0, MAX_LINES)
      .map(([productId, quantity]) => ({ productId, quantity }));
  } catch {
    return [];
  }
}

// A cookie that holds nothing usable is dropped and logged: it means a
// client sent something this app never wrote.
export async function readCart() {
  const raw = (await cookies()).get(COOKIE)?.value;
  const lines = parseCart(raw);
  if (raw && raw !== "[]" && lines.length === 0) logger.warn("cart: unreadable cookie dropped", { "cart.cookie_length": raw.length });
  return lines;
}

// Only from Server Actions (cookies can't be set while rendering).
export async function writeCart(lines: CartLine[]) {
  const store = await cookies();
  if (lines.length === 0) {
    store.delete(COOKIE);
    return;
  }
  store.set(COOKIE, JSON.stringify(lines.map((l) => [l.productId, l.quantity])), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: THIRTY_DAYS,
  });
}

export const cartCount = (lines: CartLine[]) => lines.reduce((n, l) => n + l.quantity, 0);
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
  "src/lib/info-pages.ts": `// The store's help and company pages, for the footer and each page's side
// navigation.

export const infoSections = [
  {
    title: "Help",
    links: [
      { label: "Shipping", href: "/shipping" },
      { label: "Returns", href: "/returns" },
      { label: "Care guide", href: "/care" },
      { label: "Contact us", href: "/contact" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "Our makers", href: "/makers" },
      { label: "Journal", href: "/journal" },
      { label: "Wholesale", href: "/wholesale" },
    ],
  },
] as const;

export type InfoSection = (typeof infoSections)[number]["title"];
`,
  "src/lib/jobs.ts": `import { count, lt } from "drizzle-orm";
import { db } from "@/db/client";
import { stockLevels } from "@/db/schema";
import { logger } from "@/lib/logger";
import { LOW_STOCK } from "@/lib/stock";

// Housekeeping that runs on a timer inside the server, small enough not to
// need a worker of its own: a sweep that counts the products running low,
// so the reorder list is ready when the team looks. Timers live on
// globalThis so dev hot reloads don't start a second set, and are unref'd
// so they never keep the process alive.

const FIRST_SWEEP_MS = 20_000;
const SWEEP_EVERY_MS = 2 * 60_000;

const globalForJobs = globalThis as unknown as { shopfrontJobs?: true };

async function lowStockSweep() {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  try {
    const [{ low }] = await db.select({ low: count() }).from(stockLevels).where(lt(stockLevels.onHand, LOW_STOCK));
    logger.info("stock: low-stock sweep done", { "stock.low_count": low, duration_ms: elapsed() });
  } catch (err) {
    logger.error("stock: low-stock sweep failed", { "error.message": String(err), duration_ms: elapsed() });
  }
}

export function startJobs() {
  if (globalForJobs.shopfrontJobs) return;
  globalForJobs.shopfrontJobs = true;
  setTimeout(() => {
    void lowStockSweep();
    setInterval(() => void lowStockSweep(), SWEEP_EVERY_MS).unref();
  }, FIRST_SWEEP_MS).unref();
  logger.info("jobs: scheduled", { "jobs.low_stock_sweep.every_ms": SWEEP_EVERY_MS });
}
`,
  "src/lib/logger.ts": `import { context as otelContext, logs, SeverityNumber, trace, type Attributes, type Context } from "@opentelemetry/api";

// In OTel JS SDK 3.x the Logs API lives in @opentelemetry/api (the separate
// @opentelemetry/api-logs package is the pre-3.0 line). Records emitted here
// pick up the active span context, so logs correlate with traces. The
// logger is looked up on each emit rather than held: one taken before the
// SDK registers its provider (this module loads ahead of it at boot) would
// be a no-op for good, and the lookup is a map read.
const otelLogger = () => logs.getLogger("shopfront");

export type Level = "debug" | "info" | "warn" | "error";

const levels: Level[] = ["debug", "info", "warn", "error"];

const severity: Record<Level, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

// The least severe level that gets logged, from LOG_LEVEL. The default is
// info, as in production: per-request detail is logged at debug and stays
// out of the stream until someone turns it on.
const configured = (process.env.LOG_LEVEL ?? "").toLowerCase();
export const minLevel: Level = (levels as string[]).includes(configured) ? (configured as Level) : "info";

export const isLevelEnabled = (level: Level) => levels.indexOf(level) >= levels.indexOf(minLevel);

const reserved = new Set(["time", "level", "msg", "trace_id", "span_id"]);

export type EmitOptions = {
  // Where the record happened, when it isn't the active context: a span
  // that already ended, for instance.
  context?: Context;
  // When it happened, in epoch ms, if not now.
  timestamp?: number;
};

// Emits one record to OTel and mirrors it to stdout as one JSON object per
// line, the shape log shippers expect.
export function logAt(level: Level, message: string, attributes?: Attributes, options?: EmitOptions) {
  if (!isLevelEnabled(level)) return;
  const ctx = options?.context ?? otelContext.active();
  const timestamp = options?.timestamp ?? Date.now();
  otelLogger().emit({
    severityNumber: severity[level],
    severityText: level.toUpperCase(),
    body: message,
    attributes,
    context: ctx,
    timestamp,
  });
  const span = trace.getSpanContext(ctx);
  // The line's own fields win: an attribute named \`level\` or \`msg\` can't
  // replace them.
  const line: Record<string, unknown> = { time: new Date(timestamp).toISOString(), level, msg: message };
  for (const [key, value] of Object.entries(attributes ?? {})) if (!reserved.has(key)) line[key] = value;
  if (span) Object.assign(line, { trace_id: span.traceId, span_id: span.spanId });
  process.stdout.write(\`\${JSON.stringify(line)}\\n\`);
}

export const logger = {
  debug: (msg: string, attrs?: Attributes) => logAt("debug", msg, attrs),
  info: (msg: string, attrs?: Attributes) => logAt("info", msg, attrs),
  warn: (msg: string, attrs?: Attributes) => logAt("warn", msg, attrs),
  error: (msg: string, attrs?: Attributes) => logAt("error", msg, attrs),
};
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

// Parses a route's id segment: digits only. Number() on its own would also
// take a sign, an exponent, a radix prefix or stray whitespace, so "12 " and
// "1e2" would find products. Anything else is no product.
export const parseProductId = (raw: string) => {
  if (!/^[1-9]\\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
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
