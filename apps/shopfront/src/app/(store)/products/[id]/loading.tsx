// Shown while a product page loads, in the page's own layout, so a slow
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
