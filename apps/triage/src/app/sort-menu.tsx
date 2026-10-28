"use client";

import { SortMenu } from "@/components/list-controls/sort-menu";
import { type IncidentSort, incidentSorts } from "@/lib/investigation/sort";
import type { ListParams } from "./list-params";
import { useListNavigation } from "./use-list-navigation";

// The incident list's sort. A new order starts again at its first page,
// keeping the search, filters and page size.
export function IncidentSortMenu({ params, variant }: { params: ListParams; variant?: "ghost" | "outline" }) {
  const { pending, go } = useListNavigation();
  return (
    <SortMenu
      options={incidentSorts}
      value={params.sort}
      onChange={(sort: IncidentSort) => go({ ...params, sort, page: 1 })}
      noun="incidents"
      pending={pending}
      variant={variant}
    />
  );
}
