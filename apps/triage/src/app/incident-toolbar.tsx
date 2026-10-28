"use client";

import { CircleDotIcon, ServerIcon, SignalIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SeverityBars, severityLabel, StatusIcon, statusLabel } from "@/components/incident/status-badges";
import { type FilterFacet, FilterChips, FilterMenu, type FilterValues } from "@/components/list-controls/filter-menu";
import { SearchInput } from "@/components/list-controls/search-input";
import { severityIds, statusIds } from "@/lib/sidebar-filters";
import { type IncidentFacet, type IncidentFilters, incidentFacetIds, isFiltering, type ListParams } from "./list-params";
import { IncidentSortMenu } from "./sort-menu";
import { useListNavigation } from "./use-list-navigation";

const SEARCH_DELAY_MS = 250;

const emptyFilters = Object.fromEntries(incidentFacetIds.map((f) => [f, []])) as unknown as IncidentFilters;

// The incident list's toolbar, the same list controls as the Watch page and
// the investigation log: search, Filter (status, severity, service) and
// Sort, with the filters in use as chips. The list filters on the server, so
// each change is a navigation to the list's new URL, back on its first page;
// the search waits for a pause in typing.
export function IncidentToolbar({
  params,
  counts,
  shown,
  total,
}: {
  params: ListParams;
  // How many incidents have each facet value, over the whole list.
  counts: Record<IncidentFacet, Record<string, number>>;
  shown: number;
  total: number;
}) {
  const { go } = useListNavigation();
  // The search as typed, and the last one sent. When the URL's search
  // changes to something not sent from here (Clear on the empty list, the
  // sidebar's link to the list), the box follows it.
  const [query, setQuery] = useState(params.q);
  const [sent, setSent] = useState(params.q);
  const [known, setKnown] = useState(params.q);
  if (params.q !== known) {
    setKnown(params.q);
    if (params.q !== sent) {
      setSent(params.q);
      setQuery(params.q);
    }
  }

  // A pending search runs against the latest state, not the one it was
  // typed over, so a filter picked meanwhile isn't undone.
  const latest = useRef(params);
  useEffect(() => {
    latest.current = params;
  });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const search = (text: string) => {
    setQuery(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const q = text.trim();
      setSent(q);
      go({ ...latest.current, q, page: 1 });
    }, SEARCH_DELAY_MS);
  };
  const setFilters = (values: FilterValues) =>
    go({ ...params, filters: { ...emptyFilters, ...values } as IncidentFilters, page: 1 });
  const clearAll = () => {
    clearTimeout(timer.current);
    setQuery("");
    setSent("");
    go({ ...params, q: "", filters: emptyFilters, page: 1 });
  };

  const facets = incidentFacets(counts);
  return (
    <div className="flex flex-col gap-2">
      {/* The search box gives way to its own row on narrow screens. */}
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={query}
          onChange={search}
          placeholder="Search incidents"
          label="Search incidents"
          className="min-w-48"
        />
        <div className="flex items-center gap-2">
          <FilterMenu facets={facets} values={params.filters} onChange={setFilters} />
          <IncidentSortMenu params={params} variant="outline" />
        </div>
      </div>
      {(isFiltering(params) || query.trim() !== "") && (
        <FilterChips
          facets={facets}
          values={params.filters}
          onChange={setFilters}
          onClearAll={clearAll}
          shown={shown}
          total={total}
        />
      )}
    </div>
  );
}

// The facets with the values the list has, and how many have each: status
// and severity in their own order, services most common first.
function incidentFacets(counts: Record<IncidentFacet, Record<string, number>>): FilterFacet[] {
  const present = <T extends string>(facet: IncidentFacet, values: readonly T[]) =>
    values.filter((v) => counts[facet][v]).map((v) => ({ value: v, count: counts[facet][v] }));
  return [
    {
      id: "status",
      label: "Status",
      icon: CircleDotIcon,
      options: present("status", statusIds).map(({ value, count }) => ({
        value,
        count,
        label: statusLabel[value],
        icon: (
          <span className="flex size-4 items-center justify-center">
            <StatusIcon status={value} />
          </span>
        ),
      })),
    },
    {
      id: "severity",
      label: "Severity",
      icon: SignalIcon,
      options: present("severity", severityIds).map(({ value, count }) => ({
        value,
        count,
        label: `${value.toUpperCase()} · ${severityLabel[value]}`,
        icon: <SeverityBars severity={value} />,
      })),
    },
    {
      id: "service",
      label: "Service",
      icon: ServerIcon,
      options: Object.entries(counts.service)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([value, count]) => ({ value, count, label: value })),
    },
  ];
}
