import type { Incident, IncidentStatus } from "./investigation/schema";

// The sidebar Recent group's sort and filters, kept in a cookie like the
// collapsed groups (sidebar-sections), so the server renders the list
// already filtered: no flash of the unfiltered list on load. Shared by the
// server (reads) and the client (writes); no server-only imports.

export const SIDEBAR_FILTERS_COOKIE = "sidebar_recent_filters";
const MAX_AGE = 60 * 60 * 24 * 365;

export const recentSorts = [
  { id: "newest", label: "Newest first" },
  { id: "severity", label: "Most severe first" },
  { id: "updated", label: "Recently updated" },
] as const;
export type RecentSort = (typeof recentSorts)[number]["id"];

type Severity = Incident["severity"];
export const severityIds: Severity[] = ["sev1", "sev2", "sev3", "sev4"];
export const statusIds: IncidentStatus[] = ["investigating", "awaiting_approval", "failed", "diagnosed", "resolved", "healthy"];

// What someone has to act on or watch: a fix to approve, a run to retry, a
// run in progress. The bell narrows Recent to these.
export const attentionStatuses: IncidentStatus[] = ["awaiting_approval", "failed", "investigating"];

export type RecentFilters = {
  sort: RecentSort;
  // The severities and statuses to show; empty shows them all.
  severities: Severity[];
  statuses: IncidentStatus[];
  // Only incidents with news you haven't seen, or a run in the last day.
  onlyNew: boolean;
  // The bell: only incidents that need attention.
  attentionOnly: boolean;
};

export const defaultRecentFilters: RecentFilters = {
  sort: "newest",
  severities: [],
  statuses: [],
  onlyNew: false,
  attentionOnly: false,
};

// Whether the filter menu's own choices are at their defaults; the bell is
// its own button, with its own highlight.
export const isDefaultMenu = (f: RecentFilters) =>
  f.sort === "newest" && f.severities.length === 0 && f.statuses.length === 0 && !f.onlyNew;

// The cookie's JSON, with anything unknown dropped; the defaults when it's
// missing or unreadable.
export function parseRecentFilters(value: string | undefined): RecentFilters {
  try {
    const v = JSON.parse(value ?? "") as Partial<Record<keyof RecentFilters, unknown>>;
    const pick = <T extends string>(list: unknown, allowed: T[]) =>
      Array.isArray(list) ? allowed.filter((a) => list.includes(a)) : [];
    return {
      sort: recentSorts.find((s) => s.id === v.sort)?.id ?? "newest",
      severities: pick(v.severities, severityIds),
      statuses: pick(v.statuses, statusIds),
      onlyNew: v.onlyNew === true,
      attentionOnly: v.attentionOnly === true,
    };
  } catch {
    return defaultRecentFilters;
  }
}

export function writeRecentFilters(f: RecentFilters) {
  const value = encodeURIComponent(JSON.stringify(f));
  document.cookie = `${SIDEBAR_FILTERS_COOKIE}=${value}; path=/; max-age=${MAX_AGE}; samesite=lax`;
}
