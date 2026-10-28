import type { Incident } from "./schema";
import { incidentHeadline } from "./summary";

// Search and faceted filters for the incident list: free text over what a
// row shows (title, service, headline) and its id; facets for status,
// severity and service. Values within a facet are OR'd; facets are AND'd.

export type IncidentFacetKey = "status" | "severity" | "service";

const facetValue = (i: Incident, facet: IncidentFacetKey): string =>
  facet === "status" ? i.status : facet === "severity" ? i.severity : i.service;

export function filterIncidents(
  incidents: Incident[],
  { q, filters }: { q: string; filters: Record<IncidentFacetKey, string[]> },
): Incident[] {
  const query = q.trim().toLowerCase();
  const facets = (Object.keys(filters) as IncidentFacetKey[]).filter((f) => filters[f].length > 0);
  return incidents.filter(
    (i) =>
      (!query || [i.title, i.service, incidentHeadline(i), i.id].join(" ").toLowerCase().includes(query)) &&
      facets.every((f) => filters[f].includes(facetValue(i, f))),
  );
}

// How many incidents have each value of each facet, for the Filter menu.
export function facetCounts(incidents: Incident[]): Record<IncidentFacetKey, Record<string, number>> {
  const counts: Record<IncidentFacetKey, Record<string, number>> = { status: {}, severity: {}, service: {} };
  for (const i of incidents) {
    for (const f of ["status", "severity", "service"] as const) {
      const v = facetValue(i, f);
      counts[f][v] = (counts[f][v] ?? 0) + 1;
    }
  }
  return counts;
}
