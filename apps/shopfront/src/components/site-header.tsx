import { Search, ShoppingBag } from "lucide-react";
import Link from "next/link";
import { cartCount, readCart } from "@/lib/cart";
import { categories } from "@/lib/catalog";
import { MobileSearch } from "./mobile-search";

const categoryHref = (c: string) => `/?category=${encodeURIComponent(c)}#shop`;

export async function SiteHeader() {
  const count = cartCount(await readCart());
  return (
    <>
      {/* The announcement scrolls away; only the bar below it sticks. */}
      <p className="bg-primary px-4 py-1.5 text-center text-xs text-primary-foreground">
        Free shipping on orders over $75 · 30-day returns
      </p>
      <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/75">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
          <Link href="/" className="font-serif text-xl font-semibold tracking-tight sm:text-2xl">
            Fernhill Goods
          </Link>
          <nav aria-label="Categories" className="hidden md:block">
            <ul className="flex items-center gap-1 text-sm">
              {categories.map((c) => (
                <li key={c}>
                  <Link
                    href={categoryHref(c)}
                    className="rounded-md px-3 py-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                  >
                    {c}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="ml-auto flex items-center gap-1">
            {/* Plain GET form: search works without JavaScript and the query
                lands in the URL, where the home page reads it. */}
            <form action="/#shop" role="search" className="relative hidden sm:block">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <label htmlFor="site-search" className="sr-only">
                Search products
              </label>
              <input
                id="site-search"
                name="q"
                type="search"
                placeholder="Search"
                className="h-9 w-44 rounded-lg border bg-card pr-3 pl-8 text-sm outline-none transition-[width,box-shadow] placeholder:text-muted-foreground focus-visible:w-56 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
              />
            </form>
            <MobileSearch />
            <Link
              href="/cart"
              aria-label={count === 0 ? "Cart, empty" : `Cart, ${count} ${count === 1 ? "item" : "items"}`}
              className="relative inline-flex size-11 items-center justify-center rounded-lg transition-colors outline-none hover:bg-secondary focus-visible:ring-3 focus-visible:ring-ring/40"
            >
              <ShoppingBag className="size-5" />
              {count > 0 && (
                <span
                  key={count}
                  className="absolute top-1 right-0.5 flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-primary px-1 text-[0.6875rem] font-semibold text-primary-foreground tabular-nums animate-in zoom-in-50 motion-reduce:animate-none"
                >
                  {count > 99 ? "99+" : count}
                </span>
              )}
            </Link>
          </div>
        </div>
        {/* Phones: the categories as a scrolling row under the bar. */}
        <nav aria-label="Categories" className="border-t md:hidden">
          <ul className="flex gap-1 overflow-x-auto px-2 py-0.5 text-sm [scrollbar-width:none]">
            {categories.map((c) => (
              <li key={c} className="shrink-0">
                <Link href={categoryHref(c)} className="block rounded-md px-3 py-2.5 text-muted-foreground hover:text-foreground">
                  {c}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>
    </>
  );
}
