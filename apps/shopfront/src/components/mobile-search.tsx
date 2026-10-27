"use client";

import { Search, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

// Phones: the header has no room for a search field, so the icon opens one
// in a row under the bar. Same plain GET form as the desktop field.
export function MobileSearch() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon-lg"
        className="size-11 sm:hidden"
        aria-label={open ? "Close search" : "Search products"}
        aria-expanded={open}
        aria-controls="mobile-search"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <X className="size-5" /> : <Search className="size-5" />}
      </Button>
      {/* No close on submit: unmounting the form mid-submit cancels it. The
          search loads a new page, which starts closed anyway. */}
      {open && (
        <form
          id="mobile-search"
          action="/#shop"
          role="search"
          className="absolute inset-x-0 top-full border-b bg-background px-4 py-2.5 shadow-sm animate-in fade-in-0 slide-in-from-top-1 motion-reduce:animate-none sm:hidden"
        >
          <label htmlFor="mobile-search-input" className="sr-only">
            Search products
          </label>
          <input
            id="mobile-search-input"
            name="q"
            type="search"
            autoFocus
            enterKeyHint="search"
            placeholder="Search mugs, linen, vases…"
            className="h-11 w-full rounded-lg border bg-card px-3 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
          />
        </form>
      )}
    </>
  );
}
