"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// Height of the compact bar. Whatever else sticks on the page sits below it
// (top-18 leaves a 24px gap).
export const STICKY_BAR_HEIGHT = 48;

// A page header that hands over to a compact bar once it scrolls away: the
// title, which scrolls back up, its status and the page's actions stay in
// view. Place it at full width, outside the page's column, and pass the
// column's width and gutters: the bar spans the page while its content lines
// up with the header's.
export function StickyHeader({
  title,
  status,
  actions,
  column,
  className,
  children,
}: {
  title: string;
  // Beside the title in the bar, from the sm breakpoint up.
  status?: ReactNode;
  actions?: ReactNode;
  // The page column's width and gutters, e.g. "max-w-6xl px-4 sm:px-6".
  column: string;
  className?: string;
  children: ReactNode;
}) {
  const headerRef = useRef<HTMLElement>(null);
  const [scrolledPast, setScrolledPast] = useState(false);
  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const observer = new IntersectionObserver(
      ([entry]) => setScrolledPast(!entry.isIntersecting && entry.boundingClientRect.top < STICKY_BAR_HEIGHT),
      { rootMargin: `-${STICKY_BAR_HEIGHT}px 0px 0px 0px` },
    );
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div className="sticky top-0 z-20 h-0">
        <div
          inert={!scrolledPast}
          aria-hidden={!scrolledPast}
          style={{ height: STICKY_BAR_HEIGHT }}
          className={cn(
            "absolute inset-x-0 top-0 border-b bg-background/95 backdrop-blur transition-[opacity,translate] duration-200 supports-backdrop-filter:bg-background/80 motion-reduce:transition-none",
            scrolledPast ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-1 opacity-0",
          )}
        >
          <div className={cn("mx-auto flex h-full w-full items-center gap-3", column)}>
            <button
              type="button"
              onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
              className="min-w-0 truncate text-left font-medium text-sm hover:text-muted-foreground"
            >
              {title}
            </button>
            {status && <span className="hidden shrink-0 items-center gap-2 sm:inline-flex">{status}</span>}
            {actions && <div className="ml-auto shrink-0">{actions}</div>}
          </div>
        </div>
      </div>
      <header ref={headerRef} className={cn("mx-auto w-full", column, className)}>
        {children}
      </header>
    </>
  );
}
