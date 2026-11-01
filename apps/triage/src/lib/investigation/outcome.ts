import type { StatusTone } from "@/components/ui/badge";
import { metricLabel } from "@/components/incident/metric-labels";
import { type ConfidenceGrade, gradeHypothesis, laneOf, mitigationRecovered, regressionProven, verdictHypothesis } from "./confidence-grade";
import { reopenedBy, withUnit } from "./postmortem/timeline";
import type { Hypothesis, Incident, Mitigation, Verification } from "./schema";

// Did Triage get it right? Whether the first diagnosis held, read off what
// happened after it: the mitigation and whether the metric recovered, the
// fix's regression test, the quiet window, reopenings, a fan-out lane's
// finding and what people decided. Computed from the record, never asked of
// the model: the postmortem's writer only puts it in a sentence. Pure, so
// the page, the postmortem and the exports share it.

export type SignalKind = "mitigation" | "fix" | "verification" | "reopening" | "fanout" | "human";
export type SignalStatus = "confirmed" | "contradicted" | "unknown";
export type Signal = { kind: SignalKind; status: SignalStatus; at?: string; text: string };

export type OutcomeRollup = "confirmed" | "held_with_caveats" | "contradicted" | "unverified";

export type VerdictOutcome = {
  hypothesis: { id: string; title: string; confidence: number; grade: ConfidenceGrade };
  rollup: OutcomeRollup;
  signals: Signal[];
};

export const rollupLabels: Record<OutcomeRollup, string> = {
  confirmed: "Confirmed",
  held_with_caveats: "Held with caveats",
  contradicted: "Contradicted",
  unverified: "Unverified",
};

export const rollupTone: Record<OutcomeRollup, StatusTone> = {
  confirmed: "success",
  held_with_caveats: "warning",
  contradicted: "destructive",
  unverified: "muted",
};

const firstLine = (text: string) => text.trim().split("\n")[0];

// The diagnosis the outcome is about: the verdict's root cause, else a
// leading hypothesis an inconclusive verdict still kept.
function diagnosed(incident: Incident): Hypothesis | undefined {
  const { report } = incident;
  if (!report || report.verdict.kind === "healthy") return undefined;
  return verdictHypothesis(incident) ?? report.hypotheses.find((h) => h.status === "leading");
}

// "Turning off FF_X", "Rolling back shopfront".
function mitigationDoing(m: Mitigation): string {
  return m.kind === "flag_off" ? `Turning off ${m.target}` : `Rolling back the deploy ${m.target.slice(0, 7)}`;
}

function mitigationSignals(incident: Incident): Signal[] {
  const m = incident.mitigation;
  if (!m) return [];
  if (m.state === "denied") {
    // The record keeps no reason for a denied mitigation, only that it was.
    return [{ kind: "human", status: "unknown", at: m.decidedAt, text: `A person denied the mitigation (${m.title})` }];
  }
  if (m.state !== "applied") return [];
  const r = m.recovery;
  const doing = mitigationDoing(m);
  if (!r) return [{ kind: "mitigation", status: "unknown", at: m.appliedAt, text: `${doing} was applied; no recovery is recorded` }];
  const under = `${metricLabel(r.metric)} back under ${withUnit(r.threshold, incident.trigger.unit)}`;
  if (mitigationRecovered(incident)) return [{ kind: "mitigation", status: "confirmed", at: r.recoveredAt, text: `${doing} brought ${under}` }];
  if (r.status === "not_recovered") {
    return [{ kind: "mitigation", status: "contradicted", at: r.checkedAt, text: `${doing} did not bring ${under}${r.note ? `: ${firstLine(r.note)}` : ""}` }];
  }
  return [{ kind: "mitigation", status: "unknown", at: m.appliedAt, text: `${doing} was applied; the metric is still being watched` }];
}

// A reviewer denying a fix asks for a better fix (a sturdier test, a missing
// finally), not a different diagnosis, so it neither confirms nor
// contradicts it. The fix stage declining is about the diagnosis: it found
// no code defect behind it.
function fixSignals(incident: Incident): Signal[] {
  const signals: Signal[] = [];
  (incident.fixAttempts ?? []).forEach((a, i) => {
    if (a.approval.state !== "denied") return;
    signals.push({
      kind: "human",
      status: "unknown",
      at: a.approval.decidedAt,
      text: `A reviewer denied fix ${i + 1}${a.approval.reason ? `: ${firstLine(a.approval.reason)}` : ""}`,
    });
  });
  const { fix, fixRun, approval } = incident;
  if (fix && regressionProven(incident)) {
    signals.push({
      kind: "fix",
      status: "confirmed",
      at: fixRun?.finishedAt,
      text: `The regression test "${fix.regressionTest.name}" failed on the original code and passes with the fix`,
    });
  } else if (fixRun?.status === "declined" && fixRun.declinedBecause) {
    signals.push({
      kind: "fix",
      status: "contradicted",
      at: fixRun.finishedAt,
      text: `The fix stage found no code defect to fix: ${firstLine(fixRun.declinedBecause)}`,
    });
  }
  if (fix && approval?.state === "denied") {
    signals.push({
      kind: "human",
      status: "unknown",
      at: approval.decidedAt,
      text: `A reviewer denied the fix${approval.reason ? `: ${firstLine(approval.reason)}` : ""}`,
    });
  }
  return signals;
}

const afterInWords = { mitigation: "the mitigation", fix: "the fix" } as const;
const windowInWords: Record<Verification["status"], string> = {
  verifying: "is running",
  resolved: "held",
  breached: "was breached",
  stopped: "was stopped",
};

function verificationSignals(incident: Incident): Signal[] {
  const v = incident.verification;
  if (!v) return [];
  const label = metricLabel(v.metric);
  const limit = withUnit(v.threshold, incident.trigger.unit);
  if (v.after === "manual") {
    return [{ kind: "human", status: "unknown", at: v.finishedAt ?? v.startedAt, text: `A person asked to verify again; the quiet window ${windowInWords[v.status]}` }];
  }
  // An uptime check's run of healthy checks: the endpoint came back, which
  // says nothing of why it failed.
  if (v.after === "uptime") {
    return [{ kind: "verification", status: "unknown", at: v.startedAt, text: "The endpoint answered in time again" }];
  }
  const after = afterInWords[v.after];
  switch (v.status) {
    case "resolved":
      return [{ kind: "verification", status: "confirmed", at: v.finishedAt, text: `${label} stayed under ${limit} for the ${v.windowMinutes}-minute quiet window after ${after}` }];
    case "breached":
      return [{
        kind: "verification",
        status: "contradicted",
        at: v.breachedAt,
        text: `${label} went back over ${limit}${v.breachValue !== undefined ? ` (${withUnit(v.breachValue, incident.trigger.unit)})` : ""} in the quiet window after ${after}`,
      }];
    case "verifying":
      return [{ kind: "verification", status: "unknown", at: v.startedAt, text: `${label} is being watched for ${v.windowMinutes} minutes after ${after}` }];
    default:
      return [];
  }
}

function reopeningSignals(incident: Incident): Signal[] {
  return (incident.reopenings ?? []).map((r) => ({
    kind: r.by === "person" ? "human" : "reopening",
    status: r.by === "person" ? "unknown" : "contradicted",
    at: r.at,
    text: `Reopened by ${reopenedBy[r.by]}: ${firstLine(r.why)}`,
  }));
}

function fanoutSignals(incident: Incident, hypothesis: Hypothesis): Signal[] {
  const finding = laneOf(hypothesis, incident)?.finding;
  if (!finding) return [];
  const at = incident.run?.finishedAt;
  if (finding === "supported") return [{ kind: "fanout", status: "confirmed", at, text: "Its lane found it supported" }];
  return [{ kind: "fanout", status: finding === "refuted" ? "contradicted" : "unknown", at, text: `The lead chose it although its lane found it ${finding}` }];
}

// The checks that act on the diagnosis. A fan-out lane is Triage again and
// a person's decision is a judgment, so neither confirms it on its own; both
// still count as caveats once something has.
const checks = new Set<SignalKind>(["mitigation", "fix", "verification", "reopening"]);

export function rollupOf(signals: Signal[]): OutcomeRollup {
  const confirmed = signals.some((s) => checks.has(s.kind) && s.status === "confirmed");
  const checkContradicted = signals.some((s) => checks.has(s.kind) && s.status === "contradicted");
  const contradicted = signals.some((s) => s.status === "contradicted");
  if (checkContradicted && !confirmed) return "contradicted";
  if (confirmed && contradicted) return "held_with_caveats";
  if (confirmed) return "confirmed";
  return "unverified";
}

// Undefined without a diagnosis to check: no report, or a verdict with no
// leading hypothesis (healthy, or inconclusive with none).
export function verdictOutcome(incident: Incident): VerdictOutcome | undefined {
  const hypothesis = diagnosed(incident);
  if (!hypothesis) return undefined;
  const signals = [
    ...mitigationSignals(incident),
    ...fixSignals(incident),
    ...verificationSignals(incident),
    ...reopeningSignals(incident),
    ...fanoutSignals(incident, hypothesis),
  ]
    // In time order; stable, and those without a time last.
    .map((s, i) => ({ s, i, t: s.at ? Date.parse(s.at) : Infinity }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map(({ s }) => s);
  return {
    hypothesis: {
      id: hypothesis.id,
      title: hypothesis.title,
      confidence: hypothesis.confidence,
      grade: gradeHypothesis(hypothesis, incident).grade,
    },
    rollup: rollupOf(signals),
    signals,
  };
}
