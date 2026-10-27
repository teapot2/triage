export default function Loading() {
  return (
    <div className="mx-auto max-w-6xl px-4 pt-8 sm:px-6" aria-busy="true" aria-label="Loading cart">
      <div className="h-9 w-48 animate-pulse rounded bg-secondary" />
      <div className="mt-8 grid gap-10 lg:grid-cols-[1fr_22rem]">
        <div className="divide-y border-y">
          {[0, 1].map((i) => (
            <div key={i} className="flex gap-4 py-5">
              <div className="size-20 animate-pulse rounded-lg bg-secondary sm:size-24" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-1/2 animate-pulse rounded bg-secondary" />
                <div className="h-3 w-1/3 animate-pulse rounded bg-secondary" />
              </div>
            </div>
          ))}
        </div>
        <div className="h-72 animate-pulse rounded-xl bg-secondary" />
      </div>
    </div>
  );
}
