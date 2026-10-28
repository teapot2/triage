import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { type ListParams, listHref } from "./list-params";
import { PageSizeSelect } from "./page-size-select";

// After Calendly's, Pinterest's and Navattic's list footers: rows per page on
// the left, the range shown and Previous / Next on the right. The page
// buttons are links, so each page has its own URL and the back button steps
// through them.
export function Pagination({ params, pageCount, total }: { params: ListParams; pageCount: number; total: number }) {
  const { page, size } = params;
  const first = (page - 1) * size + 1;
  const last = Math.min(page * size, total);

  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3 pt-1">
      <PageSizeSelect params={params} />
      <div className="flex items-center gap-2">
        <span className="px-1 text-muted-foreground text-sm tabular-nums">
          {first}–{last} of {total}
        </span>
        <PageLink href={page > 1 ? listHref({ ...params, page: page - 1 }) : undefined} label="Previous page">
          <ChevronLeftIcon /> Previous
        </PageLink>
        <PageLink href={page < pageCount ? listHref({ ...params, page: page + 1 }) : undefined} label="Next page">
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
