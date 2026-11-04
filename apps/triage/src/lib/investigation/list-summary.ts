import { archiveBlocker } from "./archive";
import { otherRuns, runModelsLabel } from "./reruns";
import type { Incident, IncidentStatus } from "./schema";
import { activityAt, incidentHeadline, incidentPreview, rootCauseTitle } from "./summary";

// What the pages that only list incidents need of one, saved beside its
// body on every write (store.ts) so a list never parses whole incidents,
// some of which run to half a megabyte. The shapes follow the incident's
// own, so code written against Incident reads a summary the same way;
// what a list would otherwise work out from the report, the questions or
// the re-runs is worked out here instead, once per write.
//
// A change to what goes in here bumps SUMMARY_VERSION: rows saved under an
// older one are summarised again from their body the next time a list reads
// them.

export const SUMMARY_VERSION = 5;

type Rule = NonNullable<Incident["trigger"]["rule"]>;

export type IncidentSummary = Pick<
  Incident,
  "id" | "title" | "service" | "severity" | "status" | "detectedAt" | "resolvedAt" | "archivedAt"
> & {
  // The source, for the list's replay tag (source-kind.ts).
  run?: Pick<NonNullable<Incident["run"]>, "startedAt" | "source">;
  // prMergedAt, so a merged fix reads "fix merged, verifying" (statusInWords).
  approval?: Pick<NonNullable<Incident["approval"]>, "state" | "prState" | "prMergedAt">;
  mitigation?: Pick<NonNullable<Incident["mitigation"]>, "state">;
  report?: Pick<NonNullable<Incident["report"]>, "summary">;
  trigger: { rule?: Pick<Rule, "id" | "name"> };
  // The list's line on what Triage concluded (summary.ts incidentHeadline).
  headline?: string;
  // The leading hypothesis' title on a root cause (rootCauseTitle).
  rootCause?: string;
  // The sidebar hover card's line (incidentPreview).
  takeaway?: string;
  // When it last changed in a way worth telling someone about (activityAt).
  activityAt: string;
  // Why it can't be archived yet, if it can't (archive.ts).
  archiveBlocker?: string;
  // Its runs other than its own, as the list's branches under its row.
  otherRuns: { number: number; status: IncidentStatus; models: string }[];
};

export function toSummary(incident: Incident): IncidentSummary {
  const { id, title, service, severity, status, detectedAt, resolvedAt, archivedAt, run, approval, mitigation, report } = incident;
  const rule = incident.trigger.rule;
  return {
    id,
    title,
    service,
    severity,
    status,
    detectedAt,
    resolvedAt,
    archivedAt,
    run: run && { startedAt: run.startedAt, source: run.source },
    approval: approval && { state: approval.state, prState: approval.prState, prMergedAt: approval.prMergedAt },
    mitigation: mitigation && { state: mitigation.state },
    report: report && { summary: report.summary },
    trigger: { rule: rule && { id: rule.id, name: rule.name } },
    headline: incidentHeadline(incident),
    rootCause: rootCauseTitle(incident),
    takeaway: incidentPreview(incident).takeaway,
    activityAt: activityAt(incident),
    archiveBlocker: archiveBlocker(incident),
    otherRuns: otherRuns(incident).map((r) => ({ number: r.number, status: r.status, models: runModelsLabel(r) })),
  };
}
