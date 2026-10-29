"use client";

import { CircleDotIcon, FileSearchIcon, type LucideIcon, ServerIcon, ShapesIcon, WrenchIcon } from "lucide-react";
import type { RefObject } from "react";
import { type FilterFacet, FilterChips, FilterMenu } from "@/components/list-controls/filter-menu";
import { SearchInput } from "@/components/list-controls/search-input";
import type { InvestigationStep } from "@/lib/investigation/schema";
import { activeFilterCount, emptyFilters, type Facet, type Filters, facetLabels, facetOptions, valueLabel } from "./log-filters";

const facetIcons: Record<Facet, LucideIcon> = {
  kind: ShapesIcon,
  status: CircleDotIcon,
  tool: WrenchIcon,
  service: ServerIcon,
  evidence: FileSearchIcon,
};

const facets: Facet[] = ["kind", "status", "tool", "service", "evidence"];

// Search box plus a Filter menu (one submenu per facet, values with counts),
// after Sentry's and Vercel's log search and Browserbase's filter menu.
// Applied filters show as removable chips with a result count. The same
// list controls as the Watch page's rules.
export function LogToolbar({
  steps,
  query,
  onQueryChange,
  filters,
  onFiltersChange,
  shown,
  total = steps.length,
  thoughtCount = 0,
  inputRef,
}: {
  steps: InvestigationStep[];
  query: string;
  onQueryChange: (query: string) => void;
  filters: Filters;
  onFiltersChange: (filters: Filters) => void;
  shown: number;
  // Rows the list has, when it shows more than tool calls.
  total?: number;
  // The model's thoughts on show beside the tool calls; with any, the menu
  // offers Type (thoughts or tool calls). Without, there's nothing to pick.
  thoughtCount?: number;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const options = (facet: Facet) =>
    facet === "kind"
      ? thoughtCount > 0
        ? [
            { value: "thought", count: thoughtCount },
            { value: "tool", count: steps.length },
          ]
        : []
      : facetOptions(steps, facet);
  const menuFacets: FilterFacet[] = facets.map((facet) => ({
    id: facet,
    label: facetLabels[facet],
    icon: facetIcons[facet],
    mono: facet === "tool",
    options: options(facet).map(({ value, count }) => ({ value, label: valueLabel(facet, value), count })),
  }));
  const setFilters = (values: Record<string, string[]>) => onFiltersChange({ ...emptyFilters, ...values });
  const filtering = activeFilterCount(filters) > 0 || query.trim() !== "";

  return (
    <div className="flex flex-col gap-2 pb-2 animate-in fade-in-0 slide-in-from-top-1 duration-200 ease-out motion-reduce:animate-none">
      <div className="flex items-center gap-2">
        <SearchInput
          inputRef={inputRef}
          value={query}
          onChange={onQueryChange}
          placeholder="Search tool calls, parameters, evidence"
          label="Search tool calls"
          shortcut="/"
        />
        <FilterMenu facets={menuFacets} values={filters} onChange={setFilters} />
      </div>
      {filtering && (
        <FilterChips
          facets={menuFacets}
          values={filters}
          onChange={setFilters}
          onClearAll={() => {
            onQueryChange("");
            onFiltersChange(emptyFilters);
          }}
          shown={shown}
          total={total}
        />
      )}
    </div>
  );
}
