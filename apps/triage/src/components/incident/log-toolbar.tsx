"use client";

import {
  CircleDotIcon,
  FileSearchIcon,
  ListFilterIcon,
  type LucideIcon,
  SearchIcon,
  ServerIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import type { RefObject } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { InvestigationStep } from "@/lib/investigation/schema";
import { cn } from "@/lib/utils";
import {
  activeFilterCount,
  emptyFilters,
  type Facet,
  type Filters,
  facetLabels,
  facetOptions,
  valueLabel,
} from "./log-filters";

const facetIcons: Record<Facet, LucideIcon> = {
  status: CircleDotIcon,
  tool: WrenchIcon,
  service: ServerIcon,
  evidence: FileSearchIcon,
};

const facets: Facet[] = ["status", "tool", "service", "evidence"];

// Search box plus a Filter menu (one submenu per facet, values with counts),
// after Sentry's and Vercel's log search and Browserbase's filter menu.
// Applied filters show as removable chips with a result count.
export function LogToolbar({
  steps,
  query,
  onQueryChange,
  filters,
  onFiltersChange,
  shown,
  inputRef,
}: {
  steps: InvestigationStep[];
  query: string;
  onQueryChange: (query: string) => void;
  filters: Filters;
  onFiltersChange: (filters: Filters) => void;
  shown: number;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const toggle = (facet: Facet, value: string, checked: boolean) =>
    onFiltersChange({
      ...filters,
      [facet]: checked ? [...filters[facet], value] : filters[facet].filter((v) => v !== value),
    });
  const clearFacet = (facet: Facet) => onFiltersChange({ ...filters, [facet]: [] });
  const clearAll = () => {
    onQueryChange("");
    onFiltersChange(emptyFilters);
  };

  const active = activeFilterCount(filters);
  const filtering = active > 0 || query.trim() !== "";

  return (
    <div className="flex flex-col gap-2 pb-2 animate-in fade-in-0 slide-in-from-top-1 duration-200 ease-out motion-reduce:animate-none">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                onQueryChange("");
              }
            }}
            placeholder="Search tool calls, parameters, evidence"
            aria-label="Search tool calls"
            className="h-8 pr-8 pl-8 text-sm"
          />
          {query ? (
            <button
              type="button"
              onClick={() => onQueryChange("")}
              aria-label="Clear search"
              className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              <XIcon className="size-3.5" />
            </button>
          ) : (
            <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border px-1 font-mono text-[10px] text-muted-foreground">
              /
            </kbd>
          )}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8">
              <ListFilterIcon />
              Filter
              {active > 0 && (
                <span className="rounded bg-primary px-1 font-mono text-[10px] text-primary-foreground tabular-nums">
                  {active}
                </span>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {facets.map((facet) => {
              const options = facetOptions(steps, facet);
              if (options.length === 0) return null;
              const Icon = facetIcons[facet];
              return (
                <DropdownMenuSub key={facet}>
                  <DropdownMenuSubTrigger>
                    <Icon />
                    {facetLabels[facet]}
                    {filters[facet].length > 0 && (
                      <span className="ml-auto font-mono text-muted-foreground text-xs tabular-nums">
                        {filters[facet].length}
                      </span>
                    )}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-60">
                    {options.map(({ value, count }) => (
                      <DropdownMenuCheckboxItem
                        key={value}
                        checked={filters[facet].includes(value)}
                        onCheckedChange={(checked) => toggle(facet, value, checked === true)}
                        // Keep the menu open to pick several values.
                        onSelect={(e) => e.preventDefault()}
                      >
                        <span className={cn(facet === "tool" && "font-mono text-xs")}>{valueLabel(facet, value)}</span>
                        <span className="ml-auto font-mono text-muted-foreground text-xs tabular-nums">{count}</span>
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              );
            })}
            {active > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onFiltersChange(emptyFilters)}>
                  Clear filters
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {filtering && (
        <div className="flex flex-wrap items-center gap-1.5">
          {facets
            .filter((facet) => filters[facet].length > 0)
            .map((facet) => (
              <FilterChip key={facet} facet={facet} values={filters[facet]} onRemove={() => clearFacet(facet)} />
            ))}
          <Button variant="ghost" size="xs" onClick={clearAll} className="text-muted-foreground">
            Clear
          </Button>
          <span className="ml-auto text-muted-foreground text-xs tabular-nums">
            {shown} of {steps.length}
          </span>
        </div>
      )}
    </div>
  );
}

// "Status is Error ×", "Tool is any of query_logs, query_traces ×".
function FilterChip({ facet, values, onRemove }: { facet: Facet; values: string[]; onRemove: () => void }) {
  const Icon = facetIcons[facet];
  const shown = values.length > 2 ? `${values.length} values` : values.map((v) => valueLabel(facet, v)).join(", ");
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-md border bg-muted/40 pl-2 text-xs animate-in fade-in-0 zoom-in-95 duration-150 ease-out motion-reduce:animate-none">
      <Icon className="size-3 text-muted-foreground" />
      <span className="text-muted-foreground">{facetLabels[facet]}</span>
      <span className="text-muted-foreground/70">{values.length > 1 ? "is any of" : "is"}</span>
      <span className={cn("font-medium", facet === "tool" && "font-mono")}>{shown}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${facetLabels[facet]} filter`}
        className="flex h-full w-6 items-center justify-center rounded-r-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <XIcon className="size-3" />
      </button>
    </span>
  );
}
