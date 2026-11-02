"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface MenuSection<Id extends string> {
  id: Id;
  label: string;
  icon: ReactNode;
  count?: number;
}

// Where the menu moves beside the content, as whole class names so Tailwind
// sees them. Settings' rows need more room than the report's cards, so its
// menu stays on top until the content beside it would still be ~680px wide.
const layouts = {
  "2xl": {
    grid: "@2xl:grid-cols-[11rem_minmax(0,1fr)] @2xl:gap-10",
    nav: "@2xl:sticky @2xl:top-18 @2xl:self-start",
    list: "@2xl:mx-0 @2xl:flex-col @2xl:overflow-visible @2xl:pb-0",
  },
  "4xl": {
    grid: "@4xl:grid-cols-[11rem_minmax(0,1fr)] @4xl:gap-10",
    nav: "@4xl:sticky @4xl:top-18 @4xl:self-start",
    list: "@4xl:mx-0 @4xl:flex-col @4xl:overflow-visible @4xl:pb-0",
  },
};

// A page's sections in a menu beside the content, one shown at a time: the
// incident report and Settings. Beside the content while the page is wide
// enough (a container query, so an @container ancestor decides), a row on
// top below that.
export function SectionMenu<Id extends string>({
  label,
  sections,
  current,
  onSelect,
  besideFrom = "2xl",
  children,
}: {
  label: string;
  sections: MenuSection<Id>[];
  current: Id;
  onSelect: (id: Id) => void;
  besideFrom?: keyof typeof layouts;
  children: ReactNode;
}) {
  const open = sections.find((s) => s.id === current);
  const layout = layouts[besideFrom];
  return (
    <div className={cn("grid grid-cols-[minmax(0,1fr)] gap-6", layout.grid)}>
      <nav aria-label={label} className={layout.nav}>
        <ul className={cn("-mx-1 flex gap-1 overflow-x-auto pb-1", layout.list)}>
          {sections.map((s) => {
            const active = s.id === current;
            return (
              <li key={s.id} className="shrink-0">
                <button
                  type="button"
                  onClick={() => onSelect(s.id)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors [&_svg]:size-4",
                    active
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                >
                  {s.icon}
                  {s.label}
                  {/* None yet says nothing worth a "0". */}
                  {s.count ? (
                    <span className="ml-auto pl-2 font-mono text-muted-foreground text-xs tabular-nums">{s.count}</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <section key={current} className="flex flex-col gap-5 fade-in-0 slide-in-from-bottom-1 animate-in duration-200 ease-out motion-reduce:animate-none">
        {/* The menu's highlight already names the section on screen; the
            heading stays for screen readers, who move between sections by it. */}
        <h2 className="sr-only">{open?.label}</h2>
        {children}
      </section>
    </div>
  );
}

// The open section from the URL (?section=…), so it can be linked to,
// survives a refresh, and the back button steps through it. The fallback
// leaves the URL bare.
export function selectSection<Id extends string>(searchParams: { toString(): string }, id: Id, fallback: Id) {
  const params = new URLSearchParams(searchParams.toString());
  if (id === fallback) params.delete("section");
  else params.set("section", id);
  const query = params.toString();
  window.history.pushState(null, "", query ? `?${query}` : window.location.pathname);
}
