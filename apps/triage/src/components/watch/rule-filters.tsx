import { CircleDotIcon, GaugeIcon, RouteIcon, SignalIcon } from "lucide-react";
import { SeverityBars, severityLabel } from "@/components/incident/status-badges";
import type { FilterFacet, FilterValues } from "@/components/list-controls/filter-menu";
import { StatusBadgeDot, type StatusTone } from "@/components/ui/badge";
import type { RuleState } from "@/lib/investigation/watch";
import { describeRule, metricOptions, targetOptions, type WatchRule } from "@/lib/investigation/watch-rule-model";

// Search, filters and sort for the Watch page's rules, on the app's shared
// list controls: free text over a rule's name and what it watches, facets
// for its live status, severity, routes and condition, and three orders.

export type RuleStatus = RuleState["status"];

// A rule's live states, most urgent first: the order "Needs attention
// first" sorts by, and each one's name and color, for its badge and filter.
export const ruleStatuses: { id: RuleStatus; label: string; tone: StatusTone }[] = [
  { id: "alerting", label: "Incident open", tone: "destructive" },
  { id: "breaching", label: "Over limit", tone: "warning" },
  { id: "ok", label: "OK", tone: "success" },
  { id: "idle", label: "No traffic", tone: "muted" },
  { id: "paused", label: "Paused", tone: "muted" },
];

// What the watch last made of a rule: paused when it or the watch is,
// undefined until the watch's state has loaded.
export function ruleStatus(rule: WatchRule, live: RuleState | undefined, watchOn: boolean | undefined): RuleStatus | undefined {
  if (!rule.enabled || watchOn === false) return "paused";
  return live?.status;
}

export const ruleSorts = [
  { id: "name", label: "Name" },
  { id: "attention", label: "Needs attention first" },
  { id: "severity", label: "Most severe first" },
] as const;
export type RuleSort = (typeof ruleSorts)[number]["id"];
export const defaultRuleSort: RuleSort = "name";

export const parseRuleSort = (value: string | null): RuleSort => ruleSorts.find((s) => s.id === value)?.id ?? defaultRuleSort;

// The facets, by the URL key each is kept under.
export const ruleFacetIds = ["status", "severity", "routes", "condition"] as const;
type RuleFacetId = (typeof ruleFacetIds)[number];

type StatusOf = (rule: WatchRule) => RuleStatus | undefined;

function facetValue(rule: WatchRule, facet: RuleFacetId, statusOf: StatusOf): string | undefined {
  switch (facet) {
    case "status":
      return statusOf(rule);
    case "severity":
      return rule.severity;
    case "routes":
      return rule.target.kind;
    case "condition":
      return rule.condition.metric;
  }
}

// The facets with the values the rules have, each with how many have it,
// in each facet's own order.
export function ruleFacets(rules: WatchRule[], statusOf: StatusOf): FilterFacet[] {
  const count = (facet: RuleFacetId, value: string) => rules.filter((r) => facetValue(r, facet, statusOf) === value).length;
  const options = <T extends { value: string; label: string }>(facet: RuleFacetId, all: T[], icon?: (o: T) => React.ReactNode) =>
    all.map((o) => ({ value: o.value, label: o.label, icon: icon?.(o), count: count(facet, o.value) })).filter((o) => o.count > 0);
  return [
    {
      id: "status",
      label: "Status",
      icon: CircleDotIcon,
      options: options(
        "status",
        ruleStatuses.map((s) => ({ ...s, value: s.id })),
        (s) => (
          <span className="flex size-4 items-center justify-center">
            <StatusBadgeDot tone={s.tone} />
          </span>
        ),
      ),
    },
    {
      id: "severity",
      label: "Severity",
      icon: SignalIcon,
      options: options(
        "severity",
        (["sev1", "sev2", "sev3", "sev4"] as const).map((s) => ({ value: s, label: `${s.toUpperCase()} · ${severityLabel[s]}` })),
        (s) => <SeverityBars severity={s.value as WatchRule["severity"]} />,
      ),
    },
    { id: "routes", label: "Routes", icon: RouteIcon, options: options("routes", targetOptions) },
    { id: "condition", label: "Condition", icon: GaugeIcon, options: options("condition", metricOptions) },
  ];
}

const statusRank = (s: RuleStatus | undefined) => {
  const i = ruleStatuses.findIndex((r) => r.id === s);
  return i === -1 ? ruleStatuses.length : i;
};

// The rules that match the search and every facet in use, in `sort`'s order.
export function filterRules(
  rules: WatchRule[],
  { query, facets, sort }: { query: string; facets: FilterValues; sort: RuleSort },
  statusOf: StatusOf,
): WatchRule[] {
  const q = query.trim().toLowerCase();
  const text = (r: WatchRule) =>
    [r.name, describeRule(r), r.target.kind === "route" ? r.target.route : ""].join(" ").toLowerCase();
  const byName = (a: WatchRule, b: WatchRule) => a.name.localeCompare(b.name);
  const order: Record<RuleSort, (a: WatchRule, b: WatchRule) => number> = {
    name: byName,
    attention: (a, b) => statusRank(statusOf(a)) - statusRank(statusOf(b)) || byName(a, b),
    // "sev1" < "sev2" as strings, so the most severe sorts first.
    severity: (a, b) => a.severity.localeCompare(b.severity) || byName(a, b),
  };
  return rules
    .filter(
      (r) =>
        (!q || text(r).includes(q)) &&
        ruleFacetIds.every((f) => {
          const picked = facets[f] ?? [];
          const value = facetValue(r, f, statusOf);
          return picked.length === 0 || (value !== undefined && picked.includes(value));
        }),
    )
    .sort(order[sort]);
}
