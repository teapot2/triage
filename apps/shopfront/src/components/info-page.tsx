import Link from "next/link";
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
