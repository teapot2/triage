import { gradeHypothesis } from "@/lib/investigation/confidence-grade";
import { incidentUsage } from "@/lib/investigation/cost";
import { verdictOutcome } from "@/lib/investigation/outcome";
import type { Incident } from "@/lib/investigation/schema";
import { rootCauseTitle } from "@/lib/investigation/summary";
import { defineDataset } from "../dataset";

// The incident list as its page shows it (search, filters, sort), every page
// at once: one row per incident, for a spreadsheet or a review.

// The incident with its page's absolute address, which only the request knows.
export type IncidentRow = { incident: Incident; url: string };

export const incidentUrl = (origin: string, id: string) => `${origin}/incidents/${id}`;

export const incidentList = defineDataset<IncidentRow>({
  id: "incidents",
  name: "Incidents (filtered)",
  columns: [
    { key: "id", value: ({ incident }) => incident.id },
    { key: "title", value: ({ incident }) => incident.title },
    { key: "service", value: ({ incident }) => incident.service },
    { key: "severity", value: ({ incident }) => incident.severity },
    { key: "status", value: ({ incident }) => incident.status },
    { key: "opened_by", value: ({ incident }) => incident.openedBy },
    { key: "detected_at", value: ({ incident }) => incident.detectedAt },
    { key: "mitigated_at", value: ({ incident }) => mitigatedAt(incident) },
    { key: "resolved_at", value: ({ incident }) => incident.resolvedAt },
    { key: "minutes_to_mitigate", value: ({ incident }) => minutesSince(incident.detectedAt, mitigatedAt(incident)) },
    { key: "minutes_to_resolve", value: ({ incident }) => minutesSince(incident.detectedAt, incident.resolvedAt) },
    { key: "root_cause", value: ({ incident }) => rootCauseTitle(incident) },
    { key: "confidence", value: ({ incident }) => leading(incident)?.confidence },
    // Worked out from the record, not the model's say-so: how far the
    // evidence and what came after bore the diagnosis out.
    { key: "confidence_grade", value: ({ incident }) => gradeOf(incident) },
    { key: "verdict_outcome", value: ({ incident }) => verdictOutcome(incident)?.rollup },
    { key: "fix_state", value: ({ incident }) => incident.fixRun?.status },
    { key: "pr_url", value: ({ incident }) => incident.approval?.prUrl },
    // Every stage's model calls together, for comparing runs on cost.
    { key: "input_tokens", value: ({ incident }) => incidentUsage(incident)?.tokens.inputTokens },
    { key: "cached_input_tokens", value: ({ incident }) => detailed(incident)?.tokens.cachedInputTokens },
    { key: "output_tokens", value: ({ incident }) => incidentUsage(incident)?.tokens.outputTokens },
    { key: "reasoning_tokens", value: ({ incident }) => detailed(incident)?.tokens.reasoningTokens },
    { key: "cost_usd", value: ({ incident }) => incidentUsage(incident)?.cost },
    { key: "url", value: ({ url }) => url },
  ],
  formats: ["csv", "json"],
});

const leading = (i: Incident) => i.report?.hypotheses.find((h) => h.status === "leading");

function gradeOf(i: Incident) {
  const h = leading(i);
  return h && gradeHypothesis(h, i).grade;
}

// Empty, rather than 0, for runs from before cached and reasoning tokens
// were recorded.
const detailed = (i: Incident) => {
  const usage = incidentUsage(i);
  return usage?.detailed ? usage : undefined;
};

// Only a mitigation that landed: a proposed or failed one has no time to report.
const mitigatedAt = (i: Incident) => (i.mitigation?.state === "applied" ? i.mitigation.appliedAt : undefined);

// Minutes from the alert, to one decimal. Empty when the end isn't reached
// or comes first, as the postmortem's durations leave such a span out.
export function minutesSince(from: string, to: string | undefined): number | undefined {
  if (!to) return undefined;
  const ms = Date.parse(to) - Date.parse(from);
  return ms >= 0 ? Math.round(ms / 6_000) / 10 : undefined;
}
