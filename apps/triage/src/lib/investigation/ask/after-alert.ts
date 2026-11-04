import { lowerIsWorse } from "@/components/incident/metric-labels";
import { questionEvidencePrefix } from "../recorder";
import type { Evidence, Incident, MetricPoint } from "../schema";
import { summarizeSeries } from "../tools";

// What happened after the alert, from the incident's record rather than the
// tools: the mitigation as it was applied, the recovery watch's minutes,
// the verification's window, reopenings and the resolution. The report
// block says only where the mitigation stands, and the investigation's
// evidence stops at the alert, so without this a question like "is it back
// under the limit?" was answered from the alert's own reading.
//
// The recovery and the verification each become a metric evidence item the
// answer can cite, with the question's own ID prefix (ev_q2_recovery), so a
// later question's copy never stands in for an older one. Only those the
// answer cites are kept on the question (agent.ts), like a full-context
// answer's items. This goes after the cached prefix of the prompt, since it
// changes as the record does.

export interface AfterAlert {
  text: string;
  items: Map<string, Evidence>;
}

// What a verification followed, as its line says it.
const verifiedAfter: Record<NonNullable<Incident["verification"]>["after"], string> = {
  mitigation: "the mitigation",
  fix: "the fix's PR merged",
  manual: "a person asked to verify",
  uptime: "the endpoint's checks came back healthy",
  dependencies: "the dependency fix, read from each audit",
};

const hhmm = (iso: string) => iso.slice(11, 16);
const points = (series: MetricPoint[]) => series.map((p) => `${hhmm(p.t)}=${Math.round(p.value * 100) / 100}`).join(", ");

export function afterAlert(incident: Incident, questionId: string): AfterAlert {
  const { trigger } = incident;
  const prefix = questionEvidencePrefix(questionId);
  const items = new Map<string, Evidence>();
  const lines: string[] = [];
  const unitOf = (metric: string) => (metric === trigger.metric ? ` ${trigger.unit}` : "");
  const limit = (metric: string, threshold: number) =>
    `limit ${threshold}${unitOf(metric)}, ${lowerIsWorse(metric) ? "breached under it" : "breached at or over it"}`;
  // A metric item for a series, or nothing when it has no points to show.
  const item = (id: string, metric: string, series: MetricPoint[], summary: string, observedAt: string | undefined) => {
    if (series.length === 0) return "";
    const { baseline, observed } = summarizeSeries(series);
    items.set(id, {
      id,
      tool: "query_metrics",
      kind: "metric",
      summary,
      ...(observedAt && { observedAt }),
      metric,
      unit: unitOf(metric).trim(),
      baseline,
      observed,
      series,
    });
    return ` [${id}]`;
  };

  const m = incident.mitigation;
  if (m && (m.state === "applied" || m.state === "failed" || m.state === "running")) {
    const by = m.decidedBy ? ` by ${m.decidedBy}` : "";
    const decided = m.decidedAt ? `, approved${by} at ${m.decidedAt}` : "";
    if (m.state === "applied") {
      lines.push(`- Mitigation "${m.title}"${decided}, applied at ${m.appliedAt ?? "an unrecorded time"}.${m.output ? ` Output: ${m.output}` : ""}`);
    } else if (m.state === "failed") {
      lines.push(`- Mitigation "${m.title}"${decided}, failed: ${m.error ?? "no reason recorded"}. Nothing was changed by it.`);
    } else {
      lines.push(`- Mitigation "${m.title}"${decided}, still being applied.`);
    }
    const r = m.recovery;
    if (r) {
      const status =
        r.status === "recovered"
          ? `recovered at ${r.recoveredAt ?? "?"} (two minutes back on the healthy side)`
          : r.status === "not_recovered"
            ? `not recovered${r.note ? `: ${r.note}` : ""}`
            : `still watching${r.checkedAt ? `, last read at ${r.checkedAt}` : ""}`;
      const cite = item(
        `${prefix}recovery`,
        r.metric,
        r.series,
        `Recovery watch after the mitigation: ${r.metric} per minute since ${hhmm(r.since)}, ${r.status.replace("_", " ")}`,
        r.checkedAt,
      );
      const read = r.series.length ? `: ${points(r.series)}` : ": no minutes read yet";
      lines.push(`- Recovery watch${cite}, ${r.metric} per minute from ${r.since} (${limit(r.metric, r.threshold)})${read}. ${cap(status)}.`);
    }
  }

  const v = incident.verification;
  if (v) {
    const status =
      v.status === "resolved"
        ? `resolved at ${v.finishedAt ?? v.checkedAt ?? "?"}: every minute of the window on the healthy side`
        : v.status === "breached"
          ? `breached: back past the limit at ${v.breachedAt ?? "?"}${v.breachValue !== undefined ? ` (${v.breachValue}${unitOf(v.metric)})` : ""}, so the incident reopened`
          : v.status === "stopped"
            ? `stopped before the window completed${v.note ? `: ${v.note}` : ""}`
            : `still verifying: ${v.series.length} of ${v.windowMinutes} minutes read${v.checkedAt ? `, last at ${v.checkedAt}` : ""}`;
    const cite = item(
      `${prefix}verification`,
      v.metric,
      v.series,
      `Verification after ${verifiedAfter[v.after]}: ${v.metric} per minute since ${hhmm(v.since)}, ${v.status}`,
      v.checkedAt ?? v.finishedAt,
    );
    const read = v.series.length ? `: ${points(v.series)}` : ": no minutes read yet";
    lines.push(
      `- Verification after ${verifiedAfter[v.after]}${cite}, ${v.windowMinutes} quiet minutes wanted from ${v.since} (${limit(v.metric, v.threshold)})${read}. ${cap(status)}.${v.note && v.status !== "stopped" ? ` Note: ${v.note}` : ""}`,
    );
  }

  for (const r of incident.reopenings ?? []) {
    const value = r.value !== undefined ? ` (${r.value}${unitOf(trigger.metric)})` : "";
    lines.push(`- Reopened at ${r.at} by ${r.by === "person" ? "a person" : `the ${r.by}`}: ${r.why}${value}.`);
  }
  if (incident.resolvedAt) lines.push(`- Resolved at ${incident.resolvedAt}.`);

  const head = "\nAfter the alert (from the incident record, not the tools; cite the IDs in brackets):\n";
  const text = lines.length
    ? `${head}${lines.join("\n")}\n- Status now: ${incident.status}.\n`
    : "\nAfter the alert: nothing recorded (no mitigation applied, no recovery watch or verification).\n";
  return { text, items };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
