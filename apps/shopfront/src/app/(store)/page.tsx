import { and, asc, eq, ilike, type SQL } from "drizzle-orm";
import { ArrowRight, Leaf, RotateCcw, Truck } from "lucide-react";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { ProductImage } from "@/components/product-image";
import { ProductCard } from "@/components/product-card";
import { Button } from "@/components/ui/button";
import { db } from "@/db/client";
import { products, type Product } from "@/db/schema";
import { catalog, categories, categoryBlurbs, type Category } from "@/lib/catalog";
import { logger } from "@/lib/logger";
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
  if (q) where.push(ilike(products.name, `%${q.replace(/[%_\\]/g, "\\$&")}%`));
  try {
    const rows = await db
      .select()
      .from(products)
      .where(and(...where))
      .orderBy(asc(products.id));
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
      <CategoryTiles />
      <section id="shop" aria-labelledby="shop-title" className="mx-auto max-w-6xl scroll-mt-32 px-4 pt-20 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 id="shop-title" className="font-serif text-3xl font-semibold tracking-tight">
            {q ? `Results for “${q}”` : (category ?? "All products")}
          </h2>
          <CategoryFilter active={category} q={q} />
        </div>
        <Suspense key={`${category}|${q}`} fallback={<GridSkeleton />}>
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
          {q && category ? ` in ${category}` : ""}
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
                style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
              >
                <ProductCard product={p} />
              </li>
            ))}
          </ul>
        )}
    </>
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
                href={`/?category=${encodeURIComponent(c)}#shop`}
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
    return `/${s ? `?${s}` : ""}#shop`;
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
