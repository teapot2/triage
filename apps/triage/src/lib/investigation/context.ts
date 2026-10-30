import type { Claim, Incident } from "./schema";
import type { TelemetrySource } from "./source";

// The incident as a model reads it: the alert, the report's verdict and
// hypotheses with their citations, and where the mitigation and fix stand.
// Shared by the stages that work from a finished investigation (ask,
// postmortem).

export const cite = (c: Claim) => `${c.text} [${c.evidenceIds.join(", ")}]`;

// The paragraph the investigation's prompt gains when an uptime check
// opened the incident (uptime/source.ts): what its results are and, for an
// endpoint with nothing else connected, that saying what is missing beats
// guessing a cause. Empty for every other source.
export function uptimeNote(source: TelemetrySource): string {
  const d = source.describe();
  if (!d.id.startsWith("uptime:")) return "";
  const intro =
    "This incident came from Triage's own external HTTP check of the endpoint: the uptime.* metrics, error logs of the failed checks and one span per check are its results.";
  if (!d.external) {
    return `${intro} The application's own telemetry is listed too; use both to find why the endpoint failed.`;
  }
  return `${intro} Nothing but the check results is available: no application logs, traces, database, source code or deploy history are connected. When the results alone cannot say why it failed, an inconclusive verdict naming what is missing (application logs, traces, a deploy history) is the right answer; do not guess a cause. Either way, the report must say what the results show: when it started, how it failed (timeouts, which statuses), and whether it is intermittent.`;
}

export function incidentBlock(incident: Incident, source: TelemetrySource | undefined): string {
  const { trigger, report } = incident;
  const lines = [
    `Incident: ${incident.title}`,
    `Service: ${incident.service}`,
    `Alert: ${trigger.metric} observed ${trigger.observed} ${trigger.unit} (threshold ${trigger.threshold}) at ${incident.detectedAt}`,
  ];
  if (source) lines.push(`Alert time (the tools' "now"): ${source.describe().now}`);
  if (report?.summary) lines.push(`Summary: ${report.summary}`);
  const verdict = report?.verdict;
  if (verdict?.kind === "root_cause") {
    lines.push(`Verdict: root cause, ${report!.hypotheses.find((h) => h.id === verdict.hypothesisId)?.title ?? verdict.hypothesisId}`);
  } else if (verdict?.kind === "healthy") {
    lines.push(`Verdict: healthy, ${cite(verdict.rationale)}`);
  } else if (verdict?.kind === "inconclusive") {
    lines.push(`Verdict: inconclusive, missing ${verdict.missing.join("; ")}`);
  }
  for (const h of report?.hypotheses ?? []) {
    lines.push(`Hypothesis ${h.id} (${h.status}, confidence ${h.confidence}): ${h.title}`);
    lines.push(`  symptom: ${cite(h.causalChain.symptom)}`);
    lines.push(`  propagation: ${cite(h.causalChain.propagation)}`);
    lines.push(`  root cause: ${cite(h.causalChain.rootCause)}`);
    if (h.rejectedBecause) lines.push(`  rejected because: ${cite(h.rejectedBecause)}`);
  }
  const m = incident.mitigation;
  if (m) {
    const recovery = m.recovery ? `, recovery ${m.recovery.status}` : "";
    lines.push(`Mitigation: ${m.title} (${m.state}${recovery})`);
  }
  if (incident.fix) {
    const state = [incident.fixRun?.status, incident.approval && `approval ${incident.approval.state}`].filter(Boolean).join(", ");
    lines.push(`Fix: ${incident.fix.summary}${state ? ` (${state})` : ""}`);
  } else if (incident.fixRun) {
    lines.push(`Fix: ${incident.fixRun.status}${incident.fixRun.declinedBecause ? `, ${incident.fixRun.declinedBecause}` : ""}`);
  }
  return lines.join("\n");
}
