"use client";

import Link from "next/link";
import { useState } from "react";
import { listHref, parseListParams } from "@/app/list-params";
import { StatusIcon, statusLabel } from "@/components/incident/status-badges";
import { activeFacetCount, FilterChips, FilterMenu, type FilterValues } from "@/components/list-controls/filter-menu";
import { SearchInput } from "@/components/list-controls/search-input";
import { SortMenu } from "@/components/list-controls/sort-menu";
import { Timestamp } from "@/components/timestamp";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useUrlParams } from "@/hooks/use-url-params";
import { cn } from "@/lib/utils";
import {
  defaultServiceSort,
  filterServices,
  parseServiceSort,
  type ServiceRow,
  serviceFacetIds,
  serviceFacets,
  serviceSorts,
} from "./service-filters";

// The Services page's list, under the app's list controls (search, Filter,
// Sort) kept in the URL. A live service opens its live page; one known only
// from recorded incidents opens the incident list filtered to it. Reads the
// URL, so the page renders it inside Suspense, with ServiceListSkeleton.
export function ServiceList({ services }: { services: ServiceRow[] }) {
  const { params, update, list } = useUrlParams();
  // The text is kept here as typed, and copied to the URL, so typing never
  // waits on the URL.
  const [query, setQuery] = useState(() => params.get("q") ?? "");

  const facets = serviceFacets(services);
  const values: FilterValues = Object.fromEntries(serviceFacetIds.map((id) => [id, list(id)]));
  const sort = parseServiceSort(params.get("sort"));
  const shown = filterServices(services, { query, facets: values, sort });
  const filtering = query.trim() !== "" || activeFacetCount(values) > 0;

  const search = (text: string) => {
    setQuery(text);
    update({ q: text.trim() ? text : null });
  };
  const clearAll = () => {
    setQuery("");
    update({ q: null, ...Object.fromEntries(serviceFacetIds.map((id) => [id, null])) });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        {/* The search box gives way to its own row on narrow screens. */}
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={query}
            onChange={search}
            placeholder="Search services"
            label="Search services"
            className="min-w-48"
          />
          <div className="flex items-center gap-2">
            <FilterMenu facets={facets} values={values} onChange={update} />
            <SortMenu
              options={serviceSorts}
              value={sort}
              onChange={(s) => update({ sort: s === defaultServiceSort ? null : s })}
              noun="services"
              variant="outline"
            />
          </div>
        </div>
        {filtering && (
          <FilterChips
            facets={facets}
            values={values}
            onChange={update}
            onClearAll={clearAll}
            shown={shown.length}
            total={services.length}
          />
        )}
      </div>

      {shown.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center">
          <p className="text-muted-foreground text-sm">No services match.</p>
          <Button variant="outline" size="sm" onClick={clearAll}>
            Clear search and filters
          </Button>
        </div>
      ) : (
        <ServiceRows services={shown} />
      )}
    </div>
  );
}

// The list's placeholder, and the page's Suspense fallback.
export function ServiceListSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      <Skeleton className="h-8 w-full" />
      <div className="divide-y rounded-lg border">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-6 px-4 py-3.5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="ml-auto h-4 w-64" />
          </div>
        ))}
      </div>
    </div>
  );
}

function ServiceRows({ services }: { services: ServiceRow[] }) {
  return (
    // From sm up the rows share one grid, so the columns line up and a long
    // headline truncates instead of wrapping its row.
    <ul className="divide-y rounded-lg border sm:grid sm:grid-cols-[auto_auto_minmax(0,1fr)]">
      {services.map(({ name, live, open, total, latest }) => (
        <li
          key={name}
          className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 sm:col-span-3 sm:grid sm:grid-cols-subgrid sm:gap-x-6"
        >
          <span className="flex items-center gap-2">
            <Link
              href={live ? `/services/${name}` : listHref(parseListParams({ service: name }))}
              className="flex items-center gap-2 font-medium text-sm hover:underline"
            >
              <span aria-hidden className={cn("size-2 rounded-full", open > 0 ? "bg-warning" : "bg-success")} />
              {name}
            </Link>
            {!live && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className="font-normal text-muted-foreground">
                    Recorded
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>Known from recorded telemetry only. Nothing live is coming in.</TooltipContent>
              </Tooltip>
            )}
          </span>
          <span className="text-muted-foreground text-xs tabular-nums">
            {total === 0 ? "No incidents yet" : `${open > 0 ? `${open} open` : "No open incidents"} · ${total} total`}
          </span>
          {latest && (
            <Link
              href={`/incidents/${latest.id}`}
              className="ml-auto flex min-w-0 items-center gap-2 text-sm hover:text-muted-foreground sm:ml-0 sm:justify-end"
            >
              <StatusIcon status={latest.status} />
              <span className="truncate">{latest.headline}</span>
              <span className="shrink-0 text-muted-foreground text-xs">
                {statusLabel[latest.status]} · <Timestamp date={latest.detectedAt} />
              </span>
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}
