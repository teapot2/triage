import type { Evidence, EvidenceKind, InvestigationStep, Thought } from "@/lib/investigation/schema";
import { laneLabel } from "./lanes";
import { metricLabel } from "./metric-labels";

// Search and faceted filters for the investigation log, the way log and
// trace viewers do it: free text plus Status / Tool / Service / Evidence.
// Values within a facet are OR'd; facets are AND'd.

// `kind` is the step-by-step view's Type: the model's thoughts or its tool
// calls. Every step is a tool call; the timeline shows thoughts by it.
// `lane` is a fan-out run's lane (lanes.ts), on thoughts and tool calls alike.
export type Facet = "kind" | "lane" | "status" | "tool" | "service" | "evidence";
export type Filters = Record<Facet, string[]>;

export const emptyFilters: Filters = { kind: [], lane: [], status: [], tool: [], service: [], evidence: [] };

export const facetLabels: Record<Facet, string> = {
  kind: "Type",
  lane: "Lane",
  status: "Status",
  tool: "Tool",
  service: "Service",
  evidence: "Evidence",
};

const kindLabels: Record<string, string> = { thought: "Thoughts", tool: "Tool calls" };

const statusLabels: Record<InvestigationStep["status"], string> = {
  completed: "Completed",
  error: "Error",
  running: "Running",
};

const evidenceLabels: Record<EvidenceKind, string> = {
  metric: "Metric",
  log: "Log",
  span: "Span",
  db: "Database",
  source: "Source",
  commit: "Commit",
};

export function valueLabel(facet: Facet, value: string): string {
  if (facet === "kind") return kindLabels[value] ?? value;
  if (facet === "lane") return laneLabel(value);
  if (facet === "status") return statusLabels[value as InvestigationStep["status"]] ?? value;
  if (facet === "evidence") return evidenceLabels[value as EvidenceKind] ?? value;
  return value;
}

// Evidence IDs are ev_<kind>_<n>, or ev_<prefix>_<kind>_<n> for an Ask
// question's (ev_q2_span_1) or a fan-out lane's (ev_h1_log_1).
export const kindOf = (evidenceId: string) => /^ev_(?:[a-z]\d+_)?([a-z]+)/.exec(evidenceId)?.[1] ?? evidenceId;

function serviceOf(step: InvestigationStep): string | undefined {
  if (typeof step.input.service === "string") return step.input.service;
  if (step.tool === "db_diagnostics") return "postgres";
  return undefined;
}

export function facetValues(step: InvestigationStep, facet: Facet): string[] {
  switch (facet) {
    case "kind":
      return ["tool"];
    case "lane":
      return step.lane ? [step.lane] : [];
    case "status":
      return [step.status];
    case "tool":
      return [step.tool];
    case "service": {
      const service = serviceOf(step);
      return service ? [service] : [];
    }
    case "evidence":
      return [...new Set(step.evidenceIds.map(kindOf))];
  }
}

// Each facet's values present in the log, with how many steps have them.
export function facetOptions(steps: InvestigationStep[], facet: Facet): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const step of steps) {
    for (const value of facetValues(step, facet)) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
}

// What a tool call returned, searchable like log content: the summary plus
// the payload (log message, query, code, commit message...).
function evidenceText(e: Evidence): string {
  switch (e.kind) {
    case "log":
      return `${e.summary} ${e.message}`;
    case "span":
      return `${e.summary} ${e.name} ${JSON.stringify(e.attributes)}`;
    case "metric":
      return `${e.summary} ${e.metric} ${metricLabel(e.metric)}`;
    case "db":
      return `${e.summary} ${e.query} ${JSON.stringify(e.rows)}`;
    case "source":
      return `${e.summary} ${e.file} ${e.code}`;
    case "commit":
      return `${e.summary} ${e.sha} ${e.message} ${e.files.join(" ")}`;
  }
}

function searchText(step: InvestigationStep, evidence: Map<string, Evidence>): string {
  const inputs = Object.values(step.input).map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
  const cited = step.evidenceIds.map((id) => {
    const e = evidence.get(id);
    return e ? evidenceText(e) : id;
  });
  return [step.tool, step.summary, step.error, ...inputs, ...cited].filter(Boolean).join("\n").toLowerCase();
}

export function filterSteps(
  steps: InvestigationStep[],
  query: string,
  filters: Filters,
  evidence: Map<string, Evidence>,
): InvestigationStep[] {
  const q = query.trim().toLowerCase();
  const active = (Object.keys(filters) as Facet[]).filter((f) => filters[f].length > 0);
  return steps.filter(
    (step) =>
      (!q || searchText(step, evidence).includes(q)) &&
      active.every((f) => facetValues(step, f).some((v) => filters[f].includes(v))),
  );
}

// The thoughts the step-by-step view shows. Type picks thoughts, tool calls
// or both; the other tool-call facets (Status, Tool...) are about calls, so
// with one on, thoughts show only if Type asks for them. Lane and a search
// narrow thoughts and calls alike.
export function filterThoughts(thoughts: Thought[], query: string, filters: Filters): Thought[] {
  const toolFiltersOn = activeFilterCount({ ...filters, kind: [], lane: [] }) > 0;
  const shown = filters.kind.length > 0 ? filters.kind.includes("thought") : !toolFiltersOn;
  if (!shown) return [];
  const q = query.trim().toLowerCase();
  return thoughts.filter(
    (t) =>
      (!q || `${t.text ?? ""}\n${t.reasoning ?? ""}`.toLowerCase().includes(q)) &&
      (filters.lane.length === 0 || (t.lane !== undefined && filters.lane.includes(t.lane))),
  );
}

export function activeFilterCount(filters: Filters): number {
  return Object.values(filters).reduce((n, values) => n + (values.length > 0 ? 1 : 0), 0);
}

// When a step matched somewhere you can't see in its row (a parameter, the
// evidence payload), an excerpt around the first match, so the reason for
// the match is visible. undefined when the row itself shows the match.
export function matchSnippet(
  step: InvestigationStep,
  query: string,
  evidence: Map<string, Evidence>,
  radius = 40,
): string | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const visible = `${step.tool} ${step.error ?? step.summary ?? ""}`.toLowerCase();
  if (visible.includes(q)) return undefined;
  const sources = [
    ...Object.entries(step.input).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`),
    ...step.evidenceIds.flatMap((id) => {
      const e = evidence.get(id);
      return e ? [evidenceText(e)] : [];
    }),
  ];
  for (const source of sources) {
    const flat = source.replace(/\s+/g, " ");
    const at = flat.toLowerCase().indexOf(q);
    if (at === -1) continue;
    const start = Math.max(0, at - radius);
    const end = Math.min(flat.length, at + q.length + radius);
    return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
  }
  return undefined;
}
