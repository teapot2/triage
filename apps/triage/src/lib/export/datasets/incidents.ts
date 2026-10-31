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
    { key: "confidence", value: ({ incident }) => incident.report?.hypotheses.find((h) => h.status === "leading")?.confidence },
    { key: "fix_state", value: ({ incident }) => incident.fixRun?.status },
    { key: "pr_url", value: ({ incident }) => incident.approval?.prUrl },
    { key: "url", value: ({ url }) => url },
  ],
  formats: ["csv", "json"],
});

// Only a mitigation that landed: a proposed or failed one has no time to report.
const mitigatedAt = (i: Incident) => (i.mitigation?.state === "applied" ? i.mitigation.appliedAt : undefined);

// Minutes from the alert, to one decimal. Empty when the end isn't reached
// or comes first, as the postmortem's durations leave such a span out.
export function minutesSince(from: string, to: string | undefined): number | undefined {
  if (!to) return undefined;
  const ms = Date.parse(to) - Date.parse(from);
  return ms >= 0 ? Math.round(ms / 6_000) / 10 : undefined;
}
