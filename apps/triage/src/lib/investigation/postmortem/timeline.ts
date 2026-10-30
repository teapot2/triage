import { lowerIsWorse, metricLabel } from "@/components/incident/metric-labels";
import type { Approval, FixRun, Incident, Reopening } from "../schema";

// The postmortem's timeline and headline durations, built from the
// timestamps the incident already records. Pure, so the incident page can
// build the document in the browser. Blameless: who decided is never
// named, only what was decided.

export type TimelineEvent = { at: string; event: string };
export type Duration = { label: string; ms: number };

// "500 ms", "10 connections", "5%".
export function withUnit(value: number | string, unit: string): string {
  return unit === "%" || unit === "" ? `${value}${unit}` : `${value} ${unit}`;
}

// Whether a value of the alert's metric breaches its threshold: at or over
// it, or under it for a metric where less is worse (availability).
export function breaches({ trigger }: Incident): (value: number) => boolean {
  return lowerIsWorse(trigger.metric) ? (v) => v < trigger.threshold : (v) => v >= trigger.threshold;
}

// Where the episode that fired the alert began: the first point of the last
// run breaching the threshold, at or before the alert, so an earlier
// episode still in the series doesn't count. One healthy bucket between
// two breaching ones doesn't end a run. With no breach by the alert, the
// first one after it.
export function firstBreach(incident: Incident): string | undefined {
  const { series } = incident.trigger;
  const breach = breaches(incident);
  const over = (i: number) => breach(series[i].value);
  const detected = Date.parse(incident.detectedAt);
  let i = series.findLastIndex((p) => Date.parse(p.t) <= detected);
  if (i < 0) i = series.length - 1;
  while (i >= 0 && !over(i)) i--;
  if (i < 0) return series.find((p) => Date.parse(p.t) > detected && breach(p.value))?.t;
  let start = i;
  for (let j = i - 1; j >= 0; j--) {
    if (over(j)) start = j;
    else if (!(j > 0 && over(j - 1))) break;
  }
  return series[start].t;
}

const firstLine = (text: string) => text.trim().split("\n")[0];

function verdictEvent(incident: Incident): string {
  const { run, report } = incident;
  if (run?.error || incident.status === "failed") {
    return `Investigation failed${run?.error ? `: ${firstLine(run.error)}` : ""}`;
  }
  const verdict = report?.verdict;
  if (verdict?.kind === "root_cause") {
    const leading = report?.hypotheses.find((h) => h.id === verdict.hypothesisId);
    return `Verdict: ${leading?.title ?? "root cause found"}`;
  }
  if (verdict?.kind === "healthy") return "Verdict: no issue found";
  if (verdict?.kind === "inconclusive") return "Verdict: inconclusive";
  return "Investigation finished";
}

// One run of the fix stage: when it started and how it ended.
function fixRunEvents(fixRun: FixRun, n: number): TimelineEvent[] {
  const events: TimelineEvent[] = [{ at: fixRun.startedAt, event: `Fix attempt ${n} started` }];
  if (fixRun.finishedAt) {
    const submissions = `${fixRun.attempt} submission${fixRun.attempt === 1 ? "" : "s"}`;
    const event =
      fixRun.status === "proven"
        ? `Fix attempt ${n} proven after ${submissions}`
        : fixRun.status === "declined"
          ? `Fix stage declined${fixRun.declinedBecause ? `: ${firstLine(fixRun.declinedBecause)}` : ""}`
          : fixRun.status === "failed"
            ? `Fix attempt ${n} failed`
            : undefined;
    if (event) events.push({ at: fixRun.finishedAt, event });
  }
  return events;
}

export const reopenedBy: Record<Reopening["by"], string> = {
  verification: "Triage's verification",
  watch: "Triage's watch",
  person: "a person",
};

const denied = (approval: Approval) => (approval.reason ? `denied: ${firstLine(approval.reason)}` : "denied");

export function postmortemTimeline(incident: Incident): TimelineEvent[] {
  const { trigger, run, mitigation, fixAttempts = [], fixRun, approval } = incident;
  const label = metricLabel(trigger.metric);
  const events: TimelineEvent[] = [];
  const add = (at: string | undefined, event: string) => {
    if (at) events.push({ at, event });
  };

  const crossed = lowerIsWorse(trigger.metric) ? "fell below" : "crossed";
  add(firstBreach(incident), `${label} ${crossed} ${withUnit(trigger.threshold, trigger.unit)}`);
  add(
    incident.detectedAt,
    `Alert fired; incident opened by ${incident.openedBy === "watch" ? "Triage's watch" : "a person"}`,
  );

  if (run) {
    add(run.startedAt, `Investigation started (${run.model})`);
    add(run.finishedAt, verdictEvent(incident));
  }

  if (mitigation) {
    add(mitigation.proposedAt, `Mitigation proposed: ${mitigation.title}`);
    add(mitigation.decidedAt, mitigation.state === "denied" ? "Mitigation denied" : "Mitigation approved");
    add(mitigation.appliedAt, "Mitigation applied");
    const recovery = mitigation.recovery;
    if (recovery?.recoveredAt) {
      add(
        recovery.recoveredAt,
        `${metricLabel(recovery.metric)} back under ${withUnit(recovery.threshold, trigger.unit)}`,
      );
    } else if (recovery?.status === "not_recovered") {
      add(recovery.checkedAt, `Recovery watch gave up: ${recovery.note ?? "still over the threshold"}`);
    }
  }

  fixAttempts.forEach((attempt, i) => {
    events.push(...fixRunEvents(attempt.fixRun, i + 1));
    if (attempt.approval.state === "denied") {
      add(attempt.approval.decidedAt, `Fix attempt ${i + 1} ${denied(attempt.approval)}`);
    }
  });
  if (fixRun) events.push(...fixRunEvents(fixRun, fixAttempts.length + 1));

  if (approval) {
    add(approval.requestedAt, "Fix awaiting approval");
    if (approval.state !== "pending") {
      const decided = approval.state === "approved" ? "Fix approved" : `Fix ${denied(approval)}`;
      add(approval.decidedAt, `${decided}${approval.prState === "opened" ? " · draft PR opened" : ""}`);
    }
  }

  for (const q of incident.questions ?? []) add(q.askedAt, `Question asked: ${q.text}`);

  const { verification } = incident;
  // An uptime check's recovery is a run of healthy checks, not a window.
  if (verification?.after === "uptime") {
    add(verification.startedAt, `Endpoint answering in time again; ${verification.series.length} checks in a row confirmed it`);
  } else if (verification) {
    add(
      verification.startedAt,
      `Verification started: watching ${metricLabel(verification.metric)} for ${verification.windowMinutes} min`,
    );
  }
  for (const r of incident.reopenings ?? []) add(r.at, `Reopened by ${reopenedBy[r.by]}: ${firstLine(r.why)}`);
  add(incident.resolvedAt, "Incident resolved");

  // Stable, so events at the same instant keep the order they happen in.
  return events
    .map((e, i) => ({ e, i, t: Date.parse(e.at) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map(({ e }) => e);
}

// The headline numbers: how long each stage took, from the first breach
// or the alert. Only spans whose two ends are both recorded, in order.
export function durations(incident: Incident): Duration[] {
  const breach = firstBreach(incident);
  const spans: [string, string | undefined, string | undefined][] = [
    ["Time to detect", breach, incident.detectedAt],
    ["Time to diagnose", incident.detectedAt, incident.run?.finishedAt],
    ["Time to mitigate", incident.detectedAt, incident.mitigation?.appliedAt],
    ["Time to recover", breach, incident.mitigation?.recovery?.recoveredAt],
    ["Time to resolve", breach, incident.resolvedAt],
  ];
  return spans.flatMap(([label, from, to]) => {
    if (!from || !to) return [];
    const ms = Date.parse(to) - Date.parse(from);
    return ms >= 0 ? [{ label, ms }] : [];
  });
}
