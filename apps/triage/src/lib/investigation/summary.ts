import type { Incident, IncidentStatus } from "./schema";

// Not finished yet: the sidebar's open count and the Services page use it.
export const openStatuses: IncidentStatus[] = ["investigating", "diagnosed", "awaiting_approval", "failed"];

// The leading hypothesis' title when Triage found a root cause.
export function rootCauseTitle(incident: Incident): string | undefined {
  const verdict = incident.report?.verdict;
  if (verdict?.kind !== "root_cause") return undefined;
  return incident.report?.hypotheses.find((h) => h.id === verdict.hypothesisId)?.title;
}

// When the incident last changed in a way worth telling someone about: the
// alert, its run starting or finishing, a decision on the fix. Drives the
// sidebar's "new" markers.
export function activityAt(incident: Incident): string {
  const times = [incident.detectedAt, incident.run?.startedAt, incident.run?.finishedAt, incident.approval?.decidedAt];
  return times
    .filter((t): t is string => t !== undefined)
    .reduce((latest, t) => (Date.parse(t) > Date.parse(latest) ? t : latest));
}

export type IncidentPreview = {
  // One line on what it comes down to, when there's anything to say yet.
  takeaway?: string;
};

// What the sidebar's hover card adds to the row: the takeaway, the root
// cause when Triage found one (short and specific), else the agent's
// plain-English summary, else why the run failed. Computed on the server,
// so hovering needs no request.
export function incidentPreview(i: Incident): IncidentPreview {
  return { takeaway: rootCauseTitle(i) ?? i.report?.summary ?? i.run?.error?.split("\n")[0] };
}

// One line on what Triage concluded (or why it couldn't).
export function incidentHeadline(incident: Incident): string | undefined {
  const verdict = incident.report?.verdict;
  if (!verdict) return incident.run?.error;
  if (verdict.kind === "healthy") return "No issue found";
  if (verdict.kind === "inconclusive") return "Inconclusive";
  return rootCauseTitle(incident);
}
