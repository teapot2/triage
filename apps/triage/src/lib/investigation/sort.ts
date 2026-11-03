import type { IncidentSummary } from "./list-summary";
import type { IncidentStatus } from "./schema";

// The incident list's orders. Each label says its direction, since
// "attention first" or "most severe first" have no meaningful reverse.
export const incidentSorts = [
  { id: "newest", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
  { id: "attention", label: "Needs attention first" },
  { id: "severity", label: "Most severe first" },
  { id: "updated", label: "Recently updated" },
] as const;

export type IncidentSort = (typeof incidentSorts)[number]["id"];
export const defaultSort: IncidentSort = "newest";

export function parseSort(value: string | string[] | undefined): IncidentSort {
  return incidentSorts.find((s) => s.id === value)?.id ?? defaultSort;
}

// When an incident's run started (the alert time when there's no run).
// Replayed scenarios share their alert time, so the run time is what
// tells them apart, as in the sidebar.
export const startedAt = (i: Pick<IncidentSummary, "run" | "detectedAt">) => i.run?.startedAt ?? i.detectedAt;

// What the orders read: a summary (list-summary.ts) has it all.
type Sortable = Pick<IncidentSummary, "run" | "detectedAt" | "status" | "severity" | "activityAt">;

// Most urgent first: a fix to approve, a run to retry, a run in progress,
// then open diagnoses, then the finished ones.
const statusRank: Record<IncidentStatus, number> = {
  awaiting_approval: 0,
  failed: 1,
  investigating: 2,
  diagnosed: 3,
  resolved: 4,
  healthy: 5,
};

const newestFirst = (a: Sortable, b: Sortable) => Date.parse(startedAt(b)) - Date.parse(startedAt(a));

const comparators: Record<IncidentSort, (a: Sortable, b: Sortable) => number> = {
  newest: newestFirst,
  oldest: (a, b) => -newestFirst(a, b),
  attention: (a, b) => statusRank[a.status] - statusRank[b.status] || newestFirst(a, b),
  // "sev1" < "sev2" < "sev3" < "sev4" as strings, so the most severe sorts first.
  severity: (a, b) => a.severity.localeCompare(b.severity) || newestFirst(a, b),
  updated: (a, b) => Date.parse(b.activityAt) - Date.parse(a.activityAt),
};

export function sortIncidents<T extends Sortable>(incidents: T[], sort: IncidentSort): T[] {
  return [...incidents].sort(comparators[sort]);
}
