import type { Evidence, EvidenceKind, InvestigationStep } from "@/lib/investigation/schema";
import { metricLabel } from "./metric-labels";

// Search and faceted filters for the investigation log, the way log and
// trace viewers do it: free text plus Status / Tool / Service / Evidence.
// Values within a facet are OR'd; facets are AND'd.

export type Facet = "status" | "tool" | "service" | "evidence";
export type Filters = Record<Facet, string[]>;

export const emptyFilters: Filters = { status: [], tool: [], service: [], evidence: [] };

export const facetLabels: Record<Facet, string> = {
  status: "Status",
  tool: "Tool",
  service: "Service",
  evidence: "Evidence",
};

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
  if (facet === "status") return statusLabels[value as InvestigationStep["status"]] ?? value;
  if (facet === "evidence") return evidenceLabels[value as EvidenceKind] ?? value;
  return value;
}

// Evidence IDs are ev_<kind>_<n>.
const kindOf = (evidenceId: string) => evidenceId.split("_")[1];

function serviceOf(step: InvestigationStep): string | undefined {
  if (typeof step.input.service === "string") return step.input.service;
  if (step.tool === "db_diagnostics") return "postgres";
  return undefined;
}

export function facetValues(step: InvestigationStep, facet: Facet): string[] {
  switch (facet) {
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
