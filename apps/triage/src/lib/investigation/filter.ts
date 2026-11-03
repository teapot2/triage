import type { IncidentSummary } from "./list-summary";

// Search and faceted filters for the incident list: free text over what a
// row shows (title, service, headline) and its id; facets for status,
// severity and service. Values within a facet are OR'd; facets are AND'd.
// On summaries (list-summary.ts), or anything carrying the same fields.

export type IncidentFacetKey = "status" | "severity" | "service";

type Faceted = Pick<IncidentSummary, IncidentFacetKey>;
type Searchable = Faceted & Pick<IncidentSummary, "id" | "title" | "headline">;

const facetValue = (i: Faceted, facet: IncidentFacetKey): string =>
  facet === "status" ? i.status : facet === "severity" ? i.severity : i.service;

export function filterIncidents<T extends Searchable>(
  incidents: T[],
  { q, filters }: { q: string; filters: Record<IncidentFacetKey, string[]> },
): T[] {
  const query = q.trim().toLowerCase();
  const facets = (Object.keys(filters) as IncidentFacetKey[]).filter((f) => filters[f].length > 0);
  return incidents.filter(
    (i) =>
      (!query || [i.title, i.service, i.headline, i.id].join(" ").toLowerCase().includes(query)) &&
      facets.every((f) => filters[f].includes(facetValue(i, f))),
  );
}

// How many incidents have each value of each facet, for the Filter menu.
export function facetCounts(incidents: Faceted[]): Record<IncidentFacetKey, Record<string, number>> {
  const counts: Record<IncidentFacetKey, Record<string, number>> = { status: {}, severity: {}, service: {} };
  for (const i of incidents) {
    for (const f of ["status", "severity", "service"] as const) {
      const v = facetValue(i, f);
      counts[f][v] = (counts[f][v] ?? 0) + 1;
    }
  }
  return counts;
}
