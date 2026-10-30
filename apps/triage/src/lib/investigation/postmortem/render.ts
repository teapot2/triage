import { metricLabel } from "@/components/incident/metric-labels";
import { citationOrder } from "../citations";
import type { Claim, Evidence, Incident, PostmortemActionItem } from "../schema";
import { durations, firstBreach, postmortemTimeline, withUnit } from "./timeline";

// The blameless postmortem as one Markdown document. The judgment (summary,
// impact, factors, lessons, action items) comes from `incident.postmortem`;
// everything else is rendered from the incident itself. Pure, so the
// incident page builds it in the browser for Copy and Download.
//
// Blameless: no commit author, no approver, only what happened and why.

// The sections, in order. A saved template is this list as data.
export const defaultTemplate = [
  "header",
  "summary",
  "impact",
  "timeline",
  "factors",
  "lessons",
  "lucky",
  "actions",
  "evidence",
] as const;
export type PostmortemSection = (typeof defaultTemplate)[number];

// Where the incident stands, in words: the most specific that holds.
export function statusInWords(incident: Incident): string {
  const { status, approval, mitigation } = incident;
  if (status === "resolved") return "resolved";
  if (status === "healthy") return "no issue found";
  if (status === "failed") return "investigation failed";
  if (approval?.state === "approved" && approval.prState === "opened") return "fix approved, PR open";
  if (approval?.state === "pending") return "fix awaiting approval";
  if (mitigation?.state === "applied") return "mitigated";
  return "open";
}

// Footnote numbers, the same as the evidence chips on the incident page
// (EvidenceProvider): the report's citations in page order, then the rest
// of the investigation's evidence, then each question's, from 1.
export function footnoteNumbers(incident: Incident): Map<string, number> {
  const evidence = allEvidence(incident);
  const known = new Set(evidence.map((e) => e.id));
  const order = incident.report ? citationOrder(incident.report).filter((id) => known.has(id)) : [];
  const ids = [...new Set([...order, ...evidence.map((e) => e.id)])];
  return new Map(ids.map((id, i) => [id, i + 1]));
}

function allEvidence(incident: Incident): Evidence[] {
  return [...incident.evidence, ...(incident.questions ?? []).flatMap((q) => q.evidence)];
}

const pad = (n: number) => String(n).padStart(2, "0");

// "2026-10-23", "02:14:00", "2026-10-23 02:14:00".
const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);
const time = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};
const dateTime = (iso: string) => `${day(iso)} ${time(iso)}`;

// "under 1 min", "4 min", "1 h 12 min".
export function formatMinutes(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under 1 min";
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ""}`;
}

// 2950, 14.6, 0.41
const num = (n: number) => (Math.abs(n) >= 100 ? String(Math.round(n)) : String(Number(n.toFixed(2))));

// Text safe inside a table cell.
const cell = (text: string) => text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");

const firstLine = (text: string) => text.trim().split("\n")[0];

// Renders citations as footnote markers and remembers which were used, so
// the Evidence appendix lists only those.
class Footnotes {
  readonly used = new Set<number>();
  constructor(readonly numbers: Map<string, number>) {}

  // "[3][7]", then any unknown ID struck: " ~~ev_x~~".
  markers(ids: string[] = []): string {
    const numbers: number[] = [];
    const unknown: string[] = [];
    for (const id of new Set(ids)) {
      const n = this.numbers.get(id);
      if (n === undefined) unknown.push(id);
      else numbers.push(n);
    }
    numbers.sort((a, b) => a - b).forEach((n) => this.used.add(n));
    return [numbers.map((n) => `[${n}]`).join(""), ...unknown.map((id) => `~~${id}~~`)].filter(Boolean).join(" ");
  }

  claim(claim: Claim): string {
    const markers = this.markers(claim.evidenceIds);
    return markers ? `${claim.text.trim()} ${markers}` : claim.text.trim();
  }
}

function list(items: string[], empty = "_None recorded._"): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : empty;
}

function header(incident: Incident): string {
  const pm = incident.postmortem;
  const facts = [
    incident.service,
    incident.severity.toUpperCase(),
    // "resolved", with when once it's recorded.
    incident.status === "resolved" && incident.resolvedAt
      ? `resolved ${dateTime(incident.resolvedAt)} UTC`
      : statusInWords(incident),
    `Detected ${dateTime(incident.detectedAt)} UTC${incident.openedBy === "watch" ? " by Triage's watch" : ""}`,
  ];
  if (pm?.status === "ready") {
    facts.push(`Written by Triage (${pm.model})${pm.finishedAt ? ` on ${dateTime(pm.finishedAt)} UTC` : ""}`);
  }
  return `# Postmortem: ${incident.title}\n\n${facts.join(" · ")}`;
}

function summary(incident: Incident): string {
  return `## Summary\n\n${incident.postmortem?.summary?.trim() || "Not written yet."}`;
}

// How long the alert's metric stayed over the threshold: from the first
// breach to the recovery, else to the end of the last breaching bucket.
// `ongoing` when the series ends still over it, so it lasted at least that.
export function timeOverThreshold(incident: Incident): { ms: number; ongoing: boolean } | undefined {
  const { series, threshold } = incident.trigger;
  const start = firstBreach(incident);
  if (!start) return undefined;
  const recoveredAt = incident.mitigation?.recovery?.recoveredAt;
  if (recoveredAt) return { ms: Math.max(0, Date.parse(recoveredAt) - Date.parse(start)), ongoing: false };
  const bucket = series.length > 1 ? Date.parse(series[1].t) - Date.parse(series[0].t) : 60_000;
  const lastOver = series.findLast((p) => p.value >= threshold)!;
  const ongoing = (series.at(-1)?.value ?? 0) >= threshold;
  return { ms: Date.parse(lastOver.t) + bucket - Date.parse(start), ongoing };
}

function impact(incident: Incident, notes: Footnotes): string {
  const { trigger } = incident;
  const label = metricLabel(trigger.metric);
  const peak = trigger.series.length ? Math.max(...trigger.series.map((p) => p.value)) : trigger.observed;
  const items = [
    `Peak ${label}: ${withUnit(num(peak), trigger.unit)}, against a threshold of ${withUnit(num(trigger.threshold), trigger.unit)}.`,
  ];
  const over = timeOverThreshold(incident);
  const start = firstBreach(incident);
  if (over && start) {
    items.push(
      `Over the threshold for ${over.ongoing ? "at least " : ""}${formatMinutes(over.ms)}, from ${time(start)} UTC.`,
    );
  }
  const baseline = incident.evidence.find((e) => e.kind === "metric" && e.metric === trigger.metric);
  if (baseline?.kind === "metric") {
    items.push(`Baseline before the incident: ${withUnit(num(baseline.baseline), baseline.unit)} ${notes.markers([baseline.id])}`);
  }
  const claim = incident.postmortem?.impact;
  return `## Impact\n\n${list(items)}${claim ? `\n\n${notes.claim(claim)}` : ""}`;
}

function timeline(incident: Incident): string {
  const events = postmortemTimeline(incident);
  if (!events.length) return "## Timeline\n\n_No events recorded._";
  const oneDay = events.every((e) => day(e.at) === day(events[0].at));
  const rows = events.map((e) => `| ${oneDay ? time(e.at) : dateTime(e.at)} | ${cell(e.event)} |`);
  const spans = durations(incident).map((d) => `${d.label}: ${formatMinutes(d.ms)}`);
  return [
    "## Timeline",
    ...(oneDay ? [`All times on ${day(events[0].at)}, UTC.`] : []),
    ["| Time (UTC) | Event |", "| --- | --- |", ...rows].join("\n"),
    // Two trailing spaces: a line break, so each reads on its own line.
    ...(spans.length ? [spans.join("  \n")] : []),
  ].join("\n\n");
}

function factors(incident: Incident, notes: Footnotes): string {
  const { report } = incident;
  const parts = ["## Contributing factors"];
  const verdict = report?.verdict;
  if (verdict?.kind === "root_cause") {
    const leading = report?.hypotheses.find((h) => h.id === verdict.hypothesisId);
    if (leading) {
      const { symptom, propagation, rootCause } = leading.causalChain;
      parts.push(
        `The investigation traced it from symptom to root cause: ${[symptom, propagation, rootCause].map((c) => notes.claim(c)).join(" → ")}`,
      );
    }
  } else if (verdict?.kind === "healthy") {
    parts.push(`The investigation found no fault: ${notes.claim(verdict.rationale)}`);
  } else if (verdict?.kind === "inconclusive") {
    parts.push(
      `The investigation was inconclusive${verdict.missing.length ? `; it was missing ${verdict.missing.join("; ")}` : ""}.`,
    );
  }
  const items = incident.postmortem?.contributingFactors ?? [];
  parts.push(items.length ? items.map((c, i) => `${i + 1}. ${notes.claim(c)}`).join("\n") : "_None recorded._");
  return parts.join("\n\n");
}

function lessons(incident: Incident, notes: Footnotes): string {
  const pm = incident.postmortem;
  return [
    "## Lessons",
    "### What went well",
    list((pm?.wentWell ?? []).map((c) => notes.claim(c))),
    "### What didn't",
    list((pm?.wentBadly ?? []).map((c) => notes.claim(c))),
  ].join("\n\n");
}

function lucky(incident: Incident): string {
  return `## Where we got lucky\n\n${list((incident.postmortem?.lucky ?? []).map((s) => s.trim()))}`;
}

const kindInWords: Record<PostmortemActionItem["kind"], string> = {
  fix_this: "Fix this",
  prevent_class: "Prevent the class",
  detect_sooner: "Detect sooner",
  mitigate_faster: "Mitigate faster",
};

function actions(incident: Incident, notes: Footnotes): string {
  const rows: [string, string, string][] = [];
  const { fix, approval } = incident;
  if (fix) {
    const summary = fix.summary.trim();
    rows.push([
      approval?.prUrl ? `Merge the fix: ${summary} ([PR](${approval.prUrl}))` : `Review the proposed fix: ${summary}`,
      kindInWords.fix_this,
      "P1",
    ]);
  }
  for (const item of incident.postmortem?.actionItems ?? []) {
    const markers = notes.markers(item.evidenceIds);
    rows.push([`${item.title.trim()}${markers ? ` ${markers}` : ""}`, kindInWords[item.kind], item.priority]);
  }
  if (!rows.length) return "## Action items\n\n_None recorded._";
  return [
    "## Action items",
    [
      "| # | Action | Kind | Priority | Owner | Due |",
      "| --- | --- | --- | --- | --- | --- |",
      ...rows.map(([action, kind, priority], i) => `| ${i + 1} | ${cell(action)} | ${kind} | ${priority} |  |  |`),
    ].join("\n"),
  ].join("\n\n");
}

// One evidence item in a line. Never a commit's author.
export function evidenceLine(e: Evidence): string {
  switch (e.kind) {
    case "log":
      return `Log · ${e.service} · ${e.summary}${e.observedAt ? ` · ${dateTime(e.observedAt)} UTC` : ""}`;
    case "span":
      return `Trace · ${e.service} · ${e.name}, ${num(e.durationMs)} ms, ${e.status}`;
    case "metric":
      return `Metric · ${metricLabel(e.metric)} (\`${e.metric}\`) · baseline ${num(e.baseline)}, observed ${withUnit(num(e.observed), e.unit)}`;
    case "db":
      return `Database · ${e.summary}`;
    case "source":
      return `Source · \`${e.file}:${e.startLine}\``;
    case "commit": {
      const flag = e.sha.startsWith("config:") && e.sha.slice("config:".length);
      return flag
        ? `Config change · ${flag} · ${firstLine(e.message)}`
        : `Deploy · ${e.sha.slice(0, 7)} · ${firstLine(e.message)}`;
    }
  }
}

function evidence(incident: Incident, notes: Footnotes): string {
  const byNumber = new Map<number, Evidence>();
  const byId = new Map(allEvidence(incident).map((e) => [e.id, e]));
  for (const [id, n] of notes.numbers) {
    const e = byId.get(id);
    if (e && notes.used.has(n)) byNumber.set(n, e);
  }
  const lines = [...byNumber.keys()].sort((a, b) => a - b).map((n) => `- [${n}] ${evidenceLine(byNumber.get(n)!)}`);
  return `## Evidence\n\n${lines.length ? lines.join("\n") : "_Nothing cited._"}`;
}

export function postmortemMarkdown(
  incident: Incident,
  template: readonly PostmortemSection[] = defaultTemplate,
): string {
  const notes = new Footnotes(footnoteNumbers(incident));
  const render: Record<Exclude<PostmortemSection, "evidence">, () => string> = {
    header: () => header(incident),
    summary: () => summary(incident),
    impact: () => impact(incident, notes),
    timeline: () => timeline(incident),
    factors: () => factors(incident, notes),
    lessons: () => lessons(incident, notes),
    lucky: () => lucky(incident),
    actions: () => actions(incident, notes),
  };
  // Every other section first, so the appendix knows which footnotes they used.
  const sections = new Map<PostmortemSection, string>();
  for (const key of template) if (key !== "evidence") sections.set(key, render[key]());
  if (template.includes("evidence")) sections.set("evidence", evidence(incident, notes));
  const body = template.map((key) => sections.get(key)!).join("\n\n");
  return `${body}\n\n---\n\nWritten by Triage from incident \`${incident.id}\`. A draft until the team has read it.\n`;
}
