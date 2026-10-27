import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { defaultSort, type IncidentSort } from "@/lib/investigation/sort";

export const PAGE_SIZE = 10;

// The list's URL for a sort and page, leaving out whatever is the default.
export function listHref(sort: IncidentSort, page: number): string {
  const params = new URLSearchParams();
  if (sort !== defaultSort) params.set("sort", sort);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

// A requested page as a number in range; anything else is the first page.
export function parsePage(value: string | string[] | undefined, pageCount: number): number {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, pageCount) : 1;
}

// After Navattic's and TheyDo's list footers: the range shown on the left,
// Previous / Next on the right. Links, so each page has its own URL and the
// back button steps through them.
export function Pagination({
  page,
  pageCount,
  total,
  sort,
}: {
  page: number;
  pageCount: number;
  total: number;
  sort: IncidentSort;
}) {
  const first = (page - 1) * PAGE_SIZE + 1;
  const last = Math.min(page * PAGE_SIZE, total);

  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3 pt-1">
      <span className="text-muted-foreground text-sm tabular-nums">
        Showing {first}–{last} of {total}
      </span>
      <div className="flex items-center gap-2">
        <PageLink href={page > 1 ? listHref(sort, page - 1) : undefined} label="Previous page">
          <ChevronLeftIcon /> Previous
        </PageLink>
        <span className="px-1 text-muted-foreground text-sm tabular-nums">
          Page {page} of {pageCount}
        </span>
        <PageLink href={page < pageCount ? listHref(sort, page + 1) : undefined} label="Next page">
          Next <ChevronRightIcon />
        </PageLink>
      </div>
    </nav>
  );
}

// A page link, or a disabled-looking button at either end.
function PageLink({ href, label, children }: { href?: string; label: string; children: React.ReactNode }) {
  if (!href) {
    return (
      <Button variant="outline" size="sm" disabled aria-label={label}>
        {children}
      </Button>
    );
  }
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={href} aria-label={label} scroll={false}>
        {children}
      </Link>
    </Button>
  );
}
