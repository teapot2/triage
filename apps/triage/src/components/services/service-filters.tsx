import { CircleDotIcon, RadioTowerIcon } from "lucide-react";
import type { FilterFacet, FilterValues } from "@/components/list-controls/filter-menu";
import { StatusBadgeDot, type StatusTone } from "@/components/ui/badge";
import type { AdvisorySeverity } from "@/lib/investigation/dependencies/model";
import type { IncidentStatus } from "@/lib/investigation/schema";

// Search, filters and sort for the Services page, on the app's shared list
// controls: free text over a service's name, a facet for whether it sends
// telemetry now and one for whether it has open incidents, and three orders.

export type ServiceRow = {
  name: string;
  // Sending telemetry now (or the live service, even while it's stopped).
  live: boolean;
  open: number;
  total: number;
  // The most recently run incident, and when it ran. A replay keeps its
  // recording's detectedAt, so "latest" (shown and sorted) goes by the run
  // start, as the Incidents list does.
  latest?: { id: string; status: IncidentStatus; headline: string; ranAt: string };
  // Advisories the dependency audit finds now on the service's runtime
  // dependencies, by severity, for the one service it audits.
  advisories?: { total: number; worst: AdvisorySeverity };
};

export const serviceSorts = [
  { id: "latest", label: "Latest incident first" },
  { id: "open", label: "Most open incidents first" },
  { id: "name", label: "Name" },
] as const;
export type ServiceSort = (typeof serviceSorts)[number]["id"];
export const defaultServiceSort: ServiceSort = "latest";

export const parseServiceSort = (value: string | null): ServiceSort =>
  serviceSorts.find((s) => s.id === value)?.id ?? defaultServiceSort;

// The facets, by the URL key each is kept under.
export const serviceFacetIds = ["telemetry", "incidents"] as const;
type ServiceFacetId = (typeof serviceFacetIds)[number];

const facetValue = (s: ServiceRow, facet: ServiceFacetId) =>
  facet === "telemetry" ? (s.live ? "live" : "recorded") : s.open > 0 ? "open" : "none";

const dot = (tone: StatusTone) => (
  <span className="flex size-4 items-center justify-center">
    <StatusBadgeDot tone={tone} />
  </span>
);

// The facets with the values the services have, each with how many have it.
export function serviceFacets(services: ServiceRow[]): FilterFacet[] {
  const options = (facet: ServiceFacetId, all: { value: string; label: string; icon?: React.ReactNode }[]) =>
    all
      .map((o) => ({ ...o, count: services.filter((s) => facetValue(s, facet) === o.value).length }))
      .filter((o) => o.count > 0);
  return [
    {
      id: "telemetry",
      label: "Telemetry",
      icon: RadioTowerIcon,
      options: options("telemetry", [
        { value: "live", label: "Live" },
        { value: "recorded", label: "Recorded" },
      ]),
    },
    {
      id: "incidents",
      label: "Open incidents",
      icon: CircleDotIcon,
      // The same dots as each row's.
      options: options("incidents", [
        { value: "open", label: "Some open", icon: dot("warning") },
        { value: "none", label: "None open", icon: dot("success") },
      ]),
    },
  ];
}

// The services that match the search and every facet in use, in `sort`'s order.
export function filterServices(
  services: ServiceRow[],
  { query, facets, sort }: { query: string; facets: FilterValues; sort: ServiceSort },
): ServiceRow[] {
  const q = query.trim().toLowerCase();
  const byName = (a: ServiceRow, b: ServiceRow) => a.name.localeCompare(b.name);
  // ISO timestamps sort as strings; a service with no incidents goes last.
  const latest = (s: ServiceRow) => s.latest?.ranAt ?? "";
  const order: Record<ServiceSort, (a: ServiceRow, b: ServiceRow) => number> = {
    latest: (a, b) => latest(b).localeCompare(latest(a)) || byName(a, b),
    open: (a, b) => b.open - a.open || latest(b).localeCompare(latest(a)) || byName(a, b),
    name: byName,
  };
  return services
    .filter(
      (s) =>
        (!q || s.name.toLowerCase().includes(q)) &&
        serviceFacetIds.every((f) => {
          const picked = facets[f] ?? [];
          return picked.length === 0 || picked.includes(facetValue(s, f));
        }),
    )
    .sort(order[sort]);
}
