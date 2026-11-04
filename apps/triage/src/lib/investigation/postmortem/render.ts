import { limitText, lowerIsWorse, metricLabel } from "@/components/incident/metric-labels";
import { modelLabel } from "../../models/labels";
import { citationOrder } from "../citations";
import { gradeLabels } from "../confidence-grade";
import type { IncidentSummary } from "../list-summary";
import { rollupLabels, verdictOutcome } from "../outcome";
import type { Claim, Evidence, Incident, PostmortemActionItem } from "../schema";
import { sectionKey } from "./draft";
import { type BuiltInSection, defaultTemplate, type TemplateSection } from "./template";
import { breaches, durations, firstBreach, postmortemTimeline, withUnit } from "./timeline";

// The blameless postmortem as one Markdown document: the header, the
// sections of the template the postmortem was written with (the default for
// records from before templates), then the Evidence appendix. The judgment
// (summary, impact, factors, lessons, action items, custom sections) comes
// from `incident.postmortem`; everything else is rendered from the incident
// itself. Pure, so the incident page builds it in the browser for Copy and
// Download.
//
// Blameless: no commit author, no approver, only what happened and why.

// Where the incident stands, in words: the most specific that holds. A
// summary (list-summary.ts) has all it reads but the PR's merge, which only
// a whole incident says.
export function statusInWords(
  incident: Pick<IncidentSummary, "status" | "mitigation"> & {
    approval?: NonNullable<IncidentSummary["approval"]> & { prMergedAt?: string };
  },
): string {
  const { status, approval, mitigation } = incident;
  if (status === "resolved") return "resolved";
  if (status === "healthy") return "no issue found";
  if (status === "failed") return "investigation failed";
  if (status === "investigating") return "investigating";
  if (approval?.state === "approved" && approval.prMergedAt) return "fix merged, verifying";
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
    facts.push(`Written by Triage (${modelLabel(pm.model, pm.provider, pm.reasoningEffort)})${pm.finishedAt ? ` on ${dateTime(pm.finishedAt)} UTC` : ""}`);
  }
  return `# Postmortem: ${incident.title}\n\n${facts.join(" · ")}`;
}

// While the postmortem is written (`drafting`), what isn't written yet is
// left out rather than marked missing: it is still coming.
const placeholder = (text: string, drafting: boolean) => (drafting ? "" : text);

function summary(incident: Incident, drafting: boolean): string {
  return `## Summary\n\n${incident.postmortem?.summary?.trim() || placeholder("Not written yet.", drafting)}`;
}

// How long the alert's metric stayed past the threshold: from the first
// breach to the recovery, else to the end of the last breaching bucket.
// `ongoing` when the series ends still past it, so it lasted at least that.
export function timeOverThreshold(incident: Incident): { ms: number; ongoing: boolean } | undefined {
  const { series } = incident.trigger;
  const breach = breaches(incident);
  const start = firstBreach(incident);
  if (!start) return undefined;
  const recoveredAt = incident.mitigation?.recovery?.recoveredAt;
  if (recoveredAt) return { ms: Math.max(0, Date.parse(recoveredAt) - Date.parse(start)), ongoing: false };
  const bucket = series.length > 1 ? Date.parse(series[1].t) - Date.parse(series[0].t) : 60_000;
  const lastOver = series.findLast((p) => breach(p.value))!;
  const ongoing = series.length > 0 && breach(series.at(-1)!.value);
  return { ms: Date.parse(lastOver.t) + bucket - Date.parse(start), ongoing };
}

function impact(incident: Incident, notes: Footnotes): string {
  const { trigger } = incident;
  const label = metricLabel(trigger.metric);
  // The worst point: the highest, or the lowest where less is worse.
  const low = lowerIsWorse(trigger.metric);
  const values = trigger.series.map((p) => p.value);
  const worst = values.length ? (low ? Math.min(...values) : Math.max(...values)) : trigger.observed;
  const items = [
    `${low ? "Lowest" : "Peak"} ${label}: ${withUnit(num(worst), trigger.unit)}, against a threshold of ${limitText(trigger.metric, withUnit(num(trigger.threshold), trigger.unit))}.`,
  ];
  const over = timeOverThreshold(incident);
  const start = firstBreach(incident);
  if (over && start) {
    items.push(
      `${low ? "Under" : "Over"} the threshold for ${over.ongoing ? "at least " : ""}${formatMinutes(over.ms)}, from ${time(start)} UTC.`,
    );
  }
  // Only a baseline on the healthy side of the threshold: one taken over a
  // window the fault had already reached says nothing about before it.
  const baseline = incident.evidence.find((e) => e.kind === "metric" && e.metric === trigger.metric);
  if (baseline?.kind === "metric" && !breaches(incident)(baseline.baseline)) {
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

// How the diagnosis held up: the diagnosis with its grade and the outcome the
// record shows, each signal on its own line, then the model's sentence on
// it. Everything above the sentence is the record's, so a postmortem from
// before the section existed still renders it.
function outcome(incident: Incident, notes: Footnotes, drafting: boolean): string {
  const heading = "## How the diagnosis held up";
  const result = verdictOutcome(incident);
  if (!result) return `${heading}\n\n_No diagnosis to check._`;
  const { hypothesis: h, rollup, signals } = result;
  const review = incident.postmortem?.verdictReview;
  return [
    heading,
    `Diagnosed: ${h.title.trim()}, confidence ${h.confidence} (${gradeLabels[h.grade]}). Outcome: ${rollupLabels[rollup]}.`,
    ...(signals.length ? [list(signals.map((sig) => `${sig.at ? `${dateTime(sig.at)} ` : ""}${sig.text}`))] : []),
    review?.text.trim() ? notes.claim(review) : placeholder("_Not written yet._", drafting),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function factors(incident: Incident, notes: Footnotes, drafting: boolean): string {
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
  parts.push(items.length ? items.map((c, i) => `${i + 1}. ${notes.claim(c)}`).join("\n") : placeholder("_None recorded._", drafting));
  return parts.join("\n\n");
}

function lessons(incident: Incident, notes: Footnotes, drafting: boolean): string {
  const pm = incident.postmortem;
  // While drafting, a list the model hasn't started has no heading yet.
  const part = (title: string, claims: Claim[] | undefined) =>
    drafting && !claims ? [] : [title, list((claims ?? []).map((c) => notes.claim(c)), placeholder("_None recorded._", drafting))];
  return ["## Lessons", ...part("### What went well", pm?.wentWell), ...part("### What didn't", pm?.wentBadly)].join("\n\n");
}

function lucky(incident: Incident, drafting: boolean): string {
  const items = (incident.postmortem?.lucky ?? []).map((s) => s.trim());
  return `## Where we got lucky\n\n${list(items, placeholder("_None recorded._", drafting))}`;
}

const kindInWords: Record<PostmortemActionItem["kind"], string> = {
  fix_this: "Fix this",
  prevent_class: "Prevent the class",
  detect_sooner: "Detect sooner",
  mitigate_faster: "Mitigate faster",
};

// An action item as the table lists it: `prUrl` on the fix's row once its
// PR is open.
export type ActionItem = PostmortemActionItem & { prUrl?: string };

// The action items in the table's order: the fix first, when there is one
// (to merge once its PR is open, else to review), then the postmortem's own.
// The action items export files the same list.
export function actionItems(incident: Pick<Incident, "fix" | "approval" | "postmortem">): ActionItem[] {
  const items: ActionItem[] = [];
  const { fix, approval } = incident;
  if (fix) {
    const summary = fix.summary.trim();
    items.push({
      title: approval?.prUrl ? `Merge the fix: ${summary}` : `Review the proposed fix: ${summary}`,
      kind: "fix_this",
      priority: "P1",
      ...(approval?.prUrl && { prUrl: approval.prUrl }),
    });
  }
  return [...items, ...(incident.postmortem?.actionItems ?? [])];
}

function actions(incident: Incident, notes: Footnotes, drafting: boolean): string {
  const rows = actionItems(incident).map((item): [string, string, string] => {
    const markers = notes.markers(item.evidenceIds);
    const pr = item.prUrl ? ` ([PR](${item.prUrl}))` : "";
    // A draft's item may not have its kind or priority yet.
    return [`${item.title.trim()}${pr}${markers ? ` ${markers}` : ""}`, kindInWords[item.kind] ?? "", item.priority ?? ""];
  });
  if (!rows.length) return `## Action items\n\n${placeholder("_None recorded._", drafting)}`;
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
      return `Metric · ${metricLabel(e.metric)} (\`${e.metric}\`) · baseline ${withUnit(num(e.baseline), e.unit)}, observed ${withUnit(num(e.observed), e.unit)}`;
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
    case "web":
      return `Web · [${e.title ?? e.url}](${e.url})`;
    case "incident":
      return `Earlier incident · ${e.title}${e.verdict ? ` · ${e.verdict}` : ""}`;
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

// A section the template's author named: the model's text for it.
function customSection(
  incident: Incident,
  section: Extract<TemplateSection, { kind: "custom" }>,
  notes: Footnotes,
  drafting: boolean,
): string {
  const written = incident.postmortem?.custom?.find((c) => c.id === section.id);
  const text = written?.text.trim();
  const markers = text ? notes.markers(written?.evidenceIds) : "";
  return `## ${section.name}\n\n${text ? (markers ? `${text} ${markers}` : text) : placeholder("_Not written yet._", drafting)}`;
}

// The document in parts: the header, each of the template's sections in
// order, by key (draft.ts's sectionKey), then the end: the Evidence appendix
// and the footer. The page shows them one at a time while the postmortem is
// written (`drafting`); postmortemMarkdown joins them.
export function postmortemParts(
  incident: Incident,
  { drafting = false } = {},
): { header: string; sections: { key: string; markdown: string }[]; end: string } {
  const notes = new Footnotes(footnoteNumbers(incident));
  const template = incident.postmortem?.template ?? defaultTemplate;
  const builtIn: Record<BuiltInSection, () => string> = {
    summary: () => summary(incident, drafting),
    impact: () => impact(incident, notes),
    timeline: () => timeline(incident),
    outcome: () => outcome(incident, notes, drafting),
    factors: () => factors(incident, notes, drafting),
    lessons: () => lessons(incident, notes, drafting),
    lucky: () => lucky(incident, drafting),
    actions: () => actions(incident, notes, drafting),
  };
  // The sections first, so the appendix knows which footnotes they used.
  const sections = template.sections.map((s) => ({
    key: sectionKey(s),
    markdown: s.kind === "builtin" ? builtIn[s.key]() : customSection(incident, s, notes, drafting),
  }));
  const end = `${evidence(incident, notes)}\n\n---\n\nWritten by Triage from incident \`${incident.id}\`. A draft until the team has read it.\n`;
  return { header: header(incident), sections, end };
}

export function postmortemMarkdown(incident: Incident): string {
  const { header, sections, end } = postmortemParts(incident);
  return [header, ...sections.map((s) => s.markdown), end].join("\n\n");
}
