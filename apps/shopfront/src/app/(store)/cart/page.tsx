import { inArray } from "drizzle-orm";
import { ArrowRight, Lock, ShoppingBag } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ProductImage } from "@/components/product-image";
import { Button } from "@/components/ui/button";
import { db } from "@/db/client";
import { products, type Product } from "@/db/schema";
import { readCart } from "@/lib/cart";
import { FREE_SHIPPING_CENTS, shippingFor } from "@/lib/cart-rules";
import { formatPrice } from "@/lib/catalog";
import { logger } from "@/lib/logger";
import { priceOf } from "@/lib/prices";
import { CartLineControls } from "./cart-line-controls";
import { RetryButton } from "./retry-button";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Cart" };

export default async function CartPage() {
  const lines = await readCart();
  if (lines.length === 0) return <EmptyCart />;

  let rows: Product[];
  try {
    rows = await db.select().from(products).where(inArray(products.id, lines.map((l) => l.productId)));
  } catch (err) {
    logger.error("cart: failed to load products", { "error.message": String(err) });
    return <CartUnavailable />;
  }

  // In cart order. A product that has since left the catalog drops out.
  const byId = new Map(rows.map((p) => [p.id, p]));
  const items = await Promise.all(
    lines.flatMap((l) => {
      const product = byId.get(l.productId);
      return product ? [priceOf(product).then((priceCents) => ({ product, priceCents, quantity: l.quantity }))] : [];
    }),
  );
  if (items.length === 0) return <EmptyCart />;

  const subtotal = items.reduce((sum, i) => sum + i.priceCents * i.quantity, 0);
  const shipping = shippingFor(subtotal);
  const toFree = FREE_SHIPPING_CENTS - subtotal;
  const count = items.reduce((n, i) => n + i.quantity, 0);

  return (
    <div className="mx-auto max-w-6xl px-4 pt-8 sm:px-6">
      <h1 className="font-serif text-3xl font-semibold tracking-tight sm:text-4xl">Your cart</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {count} {count === 1 ? "item" : "items"}
      </p>

      <div className="mt-8 grid gap-10 lg:grid-cols-[1fr_22rem] lg:items-start">
        <ul className="divide-y border-y">
          {items.map(({ product, priceCents, quantity }) => (
            <li key={product.id} className="flex gap-4 py-5 sm:gap-5">
              <Link
                href={`/products/${product.id}`}
                className="size-20 shrink-0 overflow-hidden rounded-lg sm:size-24"
                tabIndex={-1}
                aria-hidden="true"
              >
                <ProductImage name={product.name} art={product.art} tint={product.tint} sizes="96px" />
              </Link>
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link href={`/products/${product.id}`} className="font-medium leading-snug hover:underline hover:underline-offset-4">
                      {product.name}
                    </Link>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {product.category} · {formatPrice(priceCents)} each
                    </p>
                  </div>
                  <p className="font-medium tabular-nums">{formatPrice(priceCents * quantity)}</p>
                </div>
                <CartLineControls productId={product.id} name={product.name} quantity={quantity} />
              </div>
            </li>
          ))}
        </ul>

        <aside aria-labelledby="summary-title" className="rounded-xl border bg-card p-5 lg:sticky lg:top-24">
          <h2 id="summary-title" className="font-medium">
            Order summary
          </h2>
          {toFree > 0 ? (
            <div className="mt-4">
              <p className="text-sm">
                <span className="font-medium tabular-nums">{formatPrice(toFree)}</span> away from free shipping
              </p>
              <div
                className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary"
                role="progressbar"
                aria-label="Progress to free shipping"
                aria-valuemin={0}
                aria-valuemax={FREE_SHIPPING_CENTS}
                aria-valuenow={subtotal}
              >
                <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${Math.round((subtotal / FREE_SHIPPING_CENTS) * 100)}%` }} />
              </div>
            </div>
          ) : (
            <p className="mt-4 text-sm text-primary">Your order ships free.</p>
          )}
          <dl className="mt-5 space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Subtotal</dt>
              <dd className="tabular-nums">{formatPrice(subtotal)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Shipping</dt>
              <dd className="tabular-nums">{shipping === 0 ? "Free" : formatPrice(shipping)}</dd>
            </div>
            <div className="flex justify-between border-t pt-3 text-base font-medium">
              <dt>Total</dt>
              <dd className="tabular-nums">{formatPrice(subtotal + shipping)}</dd>
            </div>
          </dl>
          {/* No payments in a demo store; say so rather than fake a checkout. */}
          <Button size="lg" disabled className="mt-5 h-12 w-full text-base" aria-describedby="checkout-note">
            <Lock />
            Check out
          </Button>
          <p id="checkout-note" className="mt-2 text-center text-xs text-muted-foreground">
            Checkout isn&apos;t part of this demo store.
          </p>
          <Link href="/#shop" className="mt-4 flex items-center justify-center gap-1 text-sm font-medium text-primary hover:underline hover:underline-offset-4">
            Continue shopping <ArrowRight className="size-4" />
          </Link>
        </aside>
      </div>
    </div>
  );
}

function EmptyCart() {
  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center">
      <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-secondary">
        <ShoppingBag className="size-6 text-muted-foreground" />
      </div>
      <h1 className="mt-5 font-serif text-3xl font-semibold tracking-tight">Your cart is empty</h1>
      <p className="mt-3 text-muted-foreground">Mugs, linen and the odd teapot are a click away.</p>
      <Button size="lg" asChild className="mt-8 h-11 px-5">
        <Link href="/#shop">Start shopping</Link>
      </Button>
    </div>
  );
}

// The cart itself is safe in its cookie; only the product details are out
// of reach. Say that, so nobody thinks their cart was lost.
function CartUnavailable() {
  return (
    <div role="alert" className="mx-auto max-w-md px-4 py-24 text-center">
      <p className="text-sm font-medium text-primary">Something went wrong</p>
      <h1 className="mt-2 font-serif text-3xl font-semibold tracking-tight">We can&apos;t load your cart right now</h1>
      <p className="mt-3 text-muted-foreground">Your items are still saved. Please try again in a minute.</p>
      <RetryButton />
    </div>
  );
}
