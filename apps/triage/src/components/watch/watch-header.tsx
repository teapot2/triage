import Link from "next/link";
import type { ReactNode } from "react";

// A Watch subpage's header: a breadcrumb back up (Watch / API latency /
// Edit), the title with the page's actions beside it, and a line of facts
// under it. The incident page's header, in miniature.
export function WatchHeader({
  crumbs,
  current,
  title,
  actions,
  children,
}: {
  // Every level above this page, nearest last.
  crumbs: { label: string; href: string }[];
  // This page in the breadcrumb; the title when not given.
  current?: string;
  title: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-2 border-b pb-6">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-sm">
        {crumbs.map((c) => (
          <span key={c.href} className="flex items-center gap-1.5">
            <Link href={c.href} className="hover:text-foreground">
              {c.label}
            </Link>
            <span aria-hidden>/</span>
          </span>
        ))}
        <span aria-current="page" className="text-foreground">
          {current ?? title}
        </span>
      </nav>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="font-heading font-semibold text-2xl tracking-tight">{title}</h1>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-muted-foreground text-sm">{children}</div>}
    </header>
  );
}
