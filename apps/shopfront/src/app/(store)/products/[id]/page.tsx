import { ChevronRight, Star } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { BuyBox, BuyBoxSkeleton } from "@/components/buy-box";
import { ProductImage } from "@/components/product-image";
import { ProductCard } from "@/components/product-card";
import { categories, categoryDetails, formatPrice, type Category } from "@/lib/catalog";
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

  const category = categories.find((c) => c === product.category);
  const details = category ? categoryDetails[category] : null;
  const rating = product.ratingTenths / 10;
  const categoryHref = `/?category=${encodeURIComponent(product.category)}#shop`;

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
          <p className="mt-5 text-2xl font-medium tabular-nums">{formatPrice(product.priceCents)}</p>
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
    <span className="flex" role="img" aria-label={`Rated ${rating.toFixed(1)} out of 5`}>
      {[1, 2, 3, 4, 5].map((n) => {
        // How much of this star to fill: whole, none, or the remainder.
        const fill = Math.max(0, Math.min(1, rating - (n - 1)));
        return (
          <span key={n} className="relative size-4">
            <Star className="absolute inset-0 size-4 text-star/30" fill="currentColor" strokeWidth={0} />
            <span className="absolute inset-0 overflow-hidden" style={{ width: `${fill * 100}%` }}>
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
