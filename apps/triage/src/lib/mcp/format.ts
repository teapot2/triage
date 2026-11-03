import { metricLabel } from "@/components/incident/metric-labels";
import { citationOrder, otherHypotheses } from "../investigation/citations";
import { gradeHypothesis, gradeLabels, verdictHypothesis } from "../investigation/confidence-grade";
import { evidenceLine, statusInWords } from "../investigation/postmortem/render";
import { withUnit } from "../investigation/postmortem/timeline";
import type {
  Claim,
  Evidence,
  Fix,
  Incident,
  InvestigationStep,
  MetricPoint,
  Question,
  SandboxRun,
} from "../investigation/schema";
import type { IncidentSummary } from "../investigation/list-summary";
import type { Audit, StoredFinding } from "../investigation/dependencies/model";

// What Triage's MCP tools say, as Markdown a coding agent reads: the
// incident, its evidence, its fix and an answer. Every claim keeps its
// [ev_…] citations and every cited ID gets a line, so the agent can quote
// Triage without inventing evidence. Pure, so it is tested on the bundled
// examples.

// Caps on what one evidence item shows; each says when it cut.
export const SERIES_POINTS = 24;
export const CODE_LINES = 80;
export const DB_ROWS = 20;
export const MESSAGE_CHARS = 2000;

const cite = (c: Claim) => `${c.text} [${c.evidenceIds.join(", ")}]`;
// "2026-10-23 02:14:00 UTC"
const utc = (iso: string) => `${iso.slice(0, 19).replace("T", " ")} UTC`;
const firstLine = (text: string) => text.split("\n")[0].trim();
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export const incidentUrl = (baseUrl: string, id: string) => `${baseUrl}/incidents/${id}`;

// Every evidence item on the incident: the investigation's, then each
// question's.
export function allEvidence(incident: Incident): Evidence[] {
  return [...incident.evidence, ...(incident.questions ?? []).flatMap((q) => q.evidence)];
}

function allSteps(incident: Incident): InvestigationStep[] {
  return [...incident.steps, ...(incident.questions ?? []).flatMap((q) => q.steps)];
}

// The evidence the report cites, in the order the page numbers it.
export function citedEvidence(incident: Incident): Evidence[] {
  if (!incident.report) return [];
  const byId = new Map(allEvidence(incident).map((e) => [e.id, e]));
  return citationOrder(incident.report).flatMap((id) => byId.get(id) ?? []);
}

export type IncidentRow = {
  id: string;
  title: string;
  service: string;
  severity: Incident["severity"];
  status: string;
  detected_at: string;
  headline?: string;
  example: boolean;
  // When it was archived; absent on an active incident.
  archived_at?: string;
  url: string;
};

// From the incident's summary (list-summary.ts), so list_incidents reads no
// whole incident; get_incident summarises the one it has.
export function incidentRow(incident: IncidentSummary, baseUrl: string, example: boolean): IncidentRow {
  return {
    id: incident.id,
    title: incident.title,
    service: incident.service,
    severity: incident.severity,
    status: statusInWords(incident),
    detected_at: incident.detectedAt,
    headline: incident.headline ?? incident.report?.summary,
    example,
    ...(incident.archivedAt && { archived_at: incident.archivedAt }),
    url: incidentUrl(baseUrl, incident.id),
  };
}

const cell = (text: string) => text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");

export function incidentListMarkdown(rows: IncidentRow[], total: number): string {
  if (!rows.length) return "No incidents match.";
  const table = [
    "| ID | Title | Service | Severity | Status | Detected | Headline |",
    "|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| \`${r.id}\`${r.example ? " (example)" : ""}${r.archived_at ? " (archived)" : ""} | ${cell(r.title)} | ${r.service} | ${r.severity} | ${r.status} | ${utc(r.detected_at)} | ${cell(r.headline ?? "")} |`,
    ),
  ].join("\n");
  const more = total > rows.length ? `\n\n${rows.length} of ${total} shown; raise \`limit\` for more.` : "";
  return `${table}${more}\n\nUse get_incident with an ID for its report and cited evidence.`;
}

function alertSection(incident: Incident): string {
  const { trigger } = incident;
  const lines = [
    `${metricLabel(trigger.metric)} (\`${trigger.metric}\`) observed ${withUnit(trigger.observed, trigger.unit)}, threshold ${withUnit(trigger.threshold, trigger.unit)}.`,
  ];
  if (trigger.rule) lines.push(`Rule: ${trigger.rule.name}: ${trigger.rule.description}`);
  if (trigger.route) lines.push(`Route: \`${trigger.route}\``);
  if (trigger.focus) {
    lines.push(`Range investigated: ${utc(trigger.focus.from)} to ${utc(trigger.focus.to)}${trigger.focus.route ? ` on \`${trigger.focus.route}\`` : ""}`);
  }
  return `## Alert\n\n${lines.join("\n")}`;
}

// A dependency incident's advisory: what the audit found, where it comes
// from and what fixes it.
const chain = (path: string) => path.split(">").join(" > ");

function dependencySection(incident: Incident): string | undefined {
  const d = incident.dependency;
  if (!d) return undefined;
  const through = d.paths.length ? d.paths : [d.package];
  const lines = [
    `${d.advisoryId} (${d.severity}): ${d.title}`,
    `Package: \`${d.package}\` ${d.versions.map((v) => `\`${v}\``).join(", ")} found; vulnerable \`${d.vulnerable}\`, ${d.patched ? `patched \`${d.patched}\`` : "no fixed version published"}.`,
    `${d.dev ? "Dev" : "Runtime"} dependency, through: ${through.map((p) => `\`${chain(p)}\``).join("; ")}`,
    d.cwe.length ? `CWE: ${d.cwe.join(", ")}` : undefined,
    `Advisory: ${d.url}`,
    `Found by ${d.audits} audit${d.audits === 1 ? "" : "s"}, last at ${utc(d.lastFoundAt)}.${d.goneAt ? ` No audit has found it since ${utc(d.goneAt)}.` : ""}`,
  ];
  return `## Dependency advisory\n\n${lines.filter(Boolean).join("\n")}`;
}

const exposureLabels = {
  reachable: "reachable: the service's code reaches the vulnerable package",
  transitive_only: "transitive only: in the dependency tree, but nothing found leads from the service's code to it",
  not_reachable: "not reachable: only code that never runs in production would use it",
};

function verdictSection(incident: Incident): string {
  const { report, run } = incident;
  if (!report) {
    if (incident.status === "investigating") {
      return `## Verdict\n\nStill investigating: ${incident.steps.length} tool calls so far. Ask again in a minute.`;
    }
    return `## Verdict\n\nNo report.${run?.error ? ` The run failed: ${firstLine(run.error)}` : ""}`;
  }
  const { verdict } = report;
  if (verdict.kind === "healthy") return `## Verdict\n\nNo issue found. ${cite(verdict.rationale)}`;
  if (verdict.kind === "inconclusive") {
    return `## Verdict\n\nInconclusive. Missing: ${verdict.missing.join("; ")}.`;
  }
  const h = verdictHypothesis(incident);
  if (!h) return `## Verdict\n\nRoot cause: hypothesis ${verdict.hypothesisId} (not in the report).`;
  const grade = gradeLabels[gradeHypothesis(h, incident).grade];
  const exposure = incident.dependency && report.exposure;
  return [
    "## Verdict",
    `Root cause: **${h.title}** (confidence ${h.confidence}, ${grade.toLowerCase()})`,
    exposure && `Exposure: ${exposureLabels[exposure.verdict]}. ${cite(exposure.rationale)}`,
    [
      `- Symptom: ${cite(h.causalChain.symptom)}`,
      `- Propagation: ${cite(h.causalChain.propagation)}`,
      `- Root cause: ${cite(h.causalChain.rootCause)}`,
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function alsoConsidered(incident: Incident): string | undefined {
  if (!incident.report) return undefined;
  const others = otherHypotheses(incident.report);
  if (!others.length) return undefined;
  const lines = others.map((h) => {
    const why = h.rejectedBecause ? `ruled out: ${cite(h.rejectedBecause)}` : cite(h.causalChain.rootCause);
    return `- ${h.title} (${h.status}, confidence ${h.confidence}): ${why}`;
  });
  return `## Also considered\n\n${lines.join("\n")}`;
}

function mitigationSection(incident: Incident): string | undefined {
  const m = incident.mitigation;
  if (!m) return incident.noMitigation ? `## Mitigation\n\nNone proposed. ${incident.noMitigation.why}` : undefined;
  const lines = [`${m.title} (\`${m.kind}\` of \`${m.target}\`, ${m.state}, risk ${m.risk.replace("_", " ")})`, `Why: ${cite(m.why)}`];
  if (m.recovery) {
    const at = m.recovery.recoveredAt ? ` at ${utc(m.recovery.recoveredAt)}` : "";
    lines.push(`Recovery: ${m.recovery.status.replace("_", " ")}${at}`);
  }
  if (m.error) lines.push(`Error: ${firstLine(m.error)}`);
  return `## Mitigation\n\n${lines.join("\n")}`;
}

// Where the fix stands in a line: proven or not, approval, PR.
function fixState(incident: Incident): string {
  const { fixRun, approval } = incident;
  const parts: string[] = [];
  if (fixRun?.status === "proven") parts.push(`proven in the sandbox on attempt ${fixRun.attempt}`);
  else if (fixRun) parts.push(fixRun.status);
  if (approval) {
    parts.push(`approval ${approval.state}`);
    if (approval.prUrl) parts.push(`PR ${approval.prUrl}${approval.prMergedAt ? " (merged)" : ""}`);
    else if (approval.prState) parts.push(`PR ${approval.prState}`);
  }
  return parts.join(", ");
}

function fixSection(incident: Incident): string | undefined {
  const { fix, fixRun } = incident;
  if (!fix) {
    if (!fixRun) return undefined;
    const why = fixRun.declinedBecause ?? fixRun.error;
    return `## Fix\n\n${fixRun.status}${why ? `: ${firstLine(why)}` : ""}`;
  }
  return [
    "## Fix",
    `${fix.summary}\n\n${[capitalized(fixState(incident)), `Risk ${fix.risk}`].filter(Boolean).join(". ")}. Files: ${fix.files.map((f) => `\`${f}\``).join(", ")}.`,
    "The patch, its regression test and the sandbox runs: get_fix.",
  ].join("\n\n");
}

function resolutionSection(incident: Incident): string | undefined {
  const lines: string[] = [];
  if (incident.resolvedAt) lines.push(`Resolved at ${utc(incident.resolvedAt)}.`);
  const v = incident.verification;
  if (v && !incident.resolvedAt) lines.push(`Verification after the ${v.after}: ${v.status} (${v.windowMinutes} min quiet window).`);
  const reopened = incident.reopenings?.length ?? 0;
  if (reopened) lines.push(`Reopened ${reopened} time${reopened === 1 ? "" : "s"}, last: ${incident.reopenings!.at(-1)!.why}`);
  return lines.length ? `## Resolution\n\n${lines.join("\n")}` : undefined;
}

function questionsSection(incident: Incident): string | undefined {
  const asked = incident.questions ?? [];
  if (!asked.length) return undefined;
  const lines = asked.slice(-5).map((q) => `- ${q.id}${q.via === "mcp" ? " (via MCP)" : ""}: ${q.text} (${q.status})`);
  const earlier = asked.length > 5 ? `\n\n${asked.length - 5} earlier.` : "";
  return `## Questions asked\n\n${lines.join("\n")}${earlier}`;
}

function citedSection(incident: Incident): string | undefined {
  if (!incident.report) return undefined;
  const cited = citedEvidence(incident);
  if (!cited.length) return "## Cited evidence\n\nNothing cited.";
  const lines = cited.map((e) => `- [${e.id}] ${evidenceLine(e)}`);
  return `## Cited evidence\n\n${lines.join("\n")}\n\nFull items (log lines, spans, series, rows, code): get_evidence.`;
}

// The incident as get_incident returns it: the report with its causal
// chain and citations, where the mitigation and fix stand, and one line per
// cited evidence item.
export function incidentMarkdown(incident: Incident, baseUrl: string): string {
  const opened = incident.openedBy === "watch" ? " · opened by Triage's watch" : incident.openedBy === "person" ? " · opened by a person" : "";
  const header = [
    `# ${incident.title}`,
    `\`${incident.id}\` · ${incident.severity} · ${incident.service} · ${statusInWords(incident)} · detected ${utc(incident.detectedAt)}${opened}\nPage: ${incidentUrl(baseUrl, incident.id)}`,
    // Up front, so an agent knows not to ask it questions.
    incident.archivedAt &&
      `Archived ${utc(incident.archivedAt)}: read-only, so ask_incident is refused. Restore it on its page to work on it again.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const summary = incident.report?.summary && `## Summary\n\n${incident.report.summary}`;
  return [
    header,
    summary,
    verdictSection(incident),
    alsoConsidered(incident),
    dependencySection(incident),
    alertSection(incident),
    mitigationSection(incident),
    fixSection(incident),
    resolutionSection(incident),
    questionsSection(incident),
    citedSection(incident),
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Up to n points, evenly spaced, always keeping the last.
export function downsample(points: MetricPoint[], n: number): MetricPoint[] {
  if (points.length <= n) return points;
  const step = (points.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => points[Math.round(i * step)]);
}

const fence = (body: string, lang = "") => `\`\`\`${lang}\n${body}\n\`\`\``;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

function evidenceBody(e: Evidence): string {
  switch (e.kind) {
    case "log": {
      const meta = [`level ${e.level}`, `service ${e.service}`, e.count && `${e.count} occurrences`, e.traceId && `trace ${e.traceId}`];
      return `${meta.filter(Boolean).join(" · ")}\n\n${fence(clip(e.message, MESSAGE_CHARS))}`;
    }
    case "span":
      return `${e.service} · \`${e.name}\` · ${e.durationMs} ms · ${e.status} · trace ${e.traceId}\n\n${fence(JSON.stringify(e.attributes, null, 2), "json")}`;
    case "metric": {
      const shown = downsample(e.series, SERIES_POINTS);
      const cut = shown.length < e.series.length ? ` (${shown.length} of ${e.series.length} points, evenly spaced)` : "";
      const points = shown.map((p) => `${p.t.slice(0, 19)}Z  ${p.value}`).join("\n");
      return `${metricLabel(e.metric)} (\`${e.metric}\`): baseline ${withUnit(e.baseline, e.unit)}, observed ${withUnit(e.observed, e.unit)}${cut}\n\n${fence(points)}`;
    }
    case "db": {
      const rows = e.rows.slice(0, DB_ROWS);
      const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      const table = cols.length
        ? [
            `| ${cols.join(" | ")} |`,
            `|${cols.map(() => "---").join("|")}|`,
            ...rows.map((r) => `| ${cols.map((c) => cell(String(r[c] ?? ""))).join(" | ")} |`),
          ].join("\n")
        : "No rows.";
      const cut = e.rows.length > DB_ROWS ? `\n\n${DB_ROWS} of ${e.rows.length} rows shown.` : "";
      return `${fence(e.query, "sql")}\n\n${table}${cut}`;
    }
    case "source": {
      const lines = e.code.split("\n");
      const shown = lines.slice(0, CODE_LINES).map((line, i) => `${String(e.startLine + i).padStart(4)}  ${line}`);
      const cut = lines.length > CODE_LINES ? `\n\n${CODE_LINES} of ${lines.length} lines shown.` : "";
      return `\`${e.file}:${e.startLine}\`\n\n${fence(shown.join("\n"))}${cut}`;
    }
    case "commit": {
      // Never the author: Triage's records are blameless.
      const label = e.sha.startsWith("config:") ? `Config change \`${e.sha.slice("config:".length)}\`` : `Commit \`${e.sha}\``;
      const files = e.files.length ? `\n\nFiles: ${e.files.map((f) => `\`${f}\``).join(", ")}` : "";
      return `${label}\n\n${fence(e.message)}${files}`;
    }
    case "web":
      return `${e.title ? `${e.title}: ` : ""}${e.url}`;
    case "incident":
      return `Earlier incident \`${e.incidentId}\`: ${e.title}${e.verdict ? ` (${e.verdict})` : ""}`;
  }
}

// One evidence item in full (within the caps), with the tool call that
// found it, so the agent can see what was asked.
export function evidenceMarkdown(e: Evidence, incident: Incident): string {
  const step = allSteps(incident).find((s) => s.evidenceIds.includes(e.id));
  const found = step ? `\nFound by \`${step.tool}\` ${JSON.stringify(step.input)}` : "";
  const at = e.observedAt ? ` · ${utc(e.observedAt)}` : "";
  return `### ${e.id} · ${e.kind}\n\n${e.summary}${at}${found}\n\n${evidenceBody(e)}`;
}

function sandboxLine(run: SandboxRun): string {
  const tests = run.tests.map((t) => `${t.name} ${t.status}`).join(", ");
  const repro = run.repro ? `; replayed ${run.repro.request}: ${run.repro.status} in ${run.repro.latencyMs} ms` : "";
  return `- ${run.label}: exit ${run.exitCode}${tests ? `; ${tests}` : ""}${repro}`;
}

function dataChangeLine(fix: Fix): string | undefined {
  if (!fix.dataChange?.detected) return undefined;
  const unproven = fix.dataChange.unproven.length ? ` Not run in the sandbox: ${fix.dataChange.unproven.join(", ")}.` : "";
  return `**Changes stored data** (${fix.dataChange.reasons.join("; ")}): approving it needs a person to review the data change.${unproven}`;
}

// The fix as get_fix returns it: the change, how it was proven, where its
// approval stands and the patch itself. `attempt` picks an earlier, denied
// fix by its place (1 = the first); the current one by default.
export function fixMarkdown(incident: Incident, attempt?: number): string {
  const attempts = incident.fixAttempts ?? [];
  const current = incident.fix && {
    fix: incident.fix,
    validation: incident.validation,
    fixRun: incident.fixRun,
    approval: incident.approval,
  };
  const all = [...attempts, ...(current ? [current] : [])];
  if (!all.length) {
    const run = incident.fixRun;
    if (!run) return `No fix for \`${incident.id}\`: ${incident.report ? "the fix stage hasn't run" : "there is no report yet"}.`;
    const why = run.declinedBecause ?? run.error;
    return `No fix for \`${incident.id}\`. The fix stage ${run.status === "declined" ? "declined" : `is ${run.status}`}${why ? `: ${firstLine(why)}` : "."}`;
  }
  const n = attempt ?? all.length;
  const chosen = all[n - 1];
  if (!chosen) return `\`${incident.id}\` has ${all.length} fix${all.length === 1 ? "" : "es"}; pick attempt 1 to ${all.length}.`;

  const { fix, validation, approval } = chosen;
  const isCurrent = n === all.length && current !== undefined;
  const state = isCurrent ? fixState(incident) : `denied${approval?.reason ? `: ${approval.reason}` : ""}`;
  const parts = [
    `# Fix for ${incident.id}${all.length > 1 ? ` (${n} of ${all.length})` : ""}`,
    fix.summary,
    `${[capitalized(state), `Risk ${fix.risk}`].filter(Boolean).join(". ")}.`,
    dataChangeLine(fix),
    `Regression test: \`${fix.regressionTest.name}\` in \`${fix.regressionTest.file}\``,
    validation?.length ? `## Sandbox proof\n\n${validation.map(sandboxLine).join("\n")}` : undefined,
    `## Patch\n\n${fence(fix.patch.trimEnd(), "diff")}`,
  ];
  const earlier = all.length > 1 && isCurrent ? `Earlier fixes, denied: ${all.slice(0, -1).map((_, i) => `attempt ${i + 1}`).join(", ")}.` : undefined;
  return [...parts, earlier].filter(Boolean).join("\n\n");
}

// An answer as ask_incident returns it: the text with its citations, then
// one line per cited item.
export function answerMarkdown(question: Question, incident: Incident, baseUrl: string): string {
  if (question.status === "failed") {
    return `Triage couldn't answer ${question.id}: ${question.error ?? "unknown error"}`;
  }
  const byId = new Map(allEvidence(incident).map((e) => [e.id, e]));
  const cited = question.citedIds.flatMap((id) => byId.get(id) ?? []);
  const parts = [
    question.answer,
    cited.length ? `Cited evidence:\n${cited.map((e) => `- [${e.id}] ${evidenceLine(e)}`).join("\n")}` : undefined,
    question.unknownIds.length ? `Not real evidence (ignore these citations): ${question.unknownIds.join(", ")}` : undefined,
    `Saved as ${question.id} on ${incidentUrl(baseUrl, incident.id)}${question.mode === "evidence_only" ? " (answered from the recorded evidence; no tools for this incident)" : ""}.`,
  ];
  return parts.filter(Boolean).join("\n\n");
}

// The audited service's findings as list_dependency_findings returns them:
// the latest audit, then a row per advisory, most severe first.
export function dependencyFindingsMarkdown(
  service: string,
  findings: StoredFinding[],
  audit: Audit | undefined,
): string {
  const advisories = (n: number) => `${n} runtime advisor${n === 1 ? "y" : "ies"}`;
  const audited = !audit
    ? `\`${service}\`'s dependencies haven't been audited yet. Start an audit from the Watch page.`
    : audit.error
      ? `The latest audit of \`${service}\` (${utc(audit.at)}) failed: ${firstLine(audit.error)}. The findings below are from the last audit that ran.`
      : `Latest audit of \`${service}\`: ${utc(audit.at)}${audit.packageManager ? ` with ${audit.packageManager}` : ""}, ${advisories(audit.runtime)}.`;
  if (!findings.length) return `${audited}\n\nNo vulnerable dependencies found.`;
  const through = (f: StoredFinding) => {
    const shown = f.paths.slice(0, 3).map(chain).join("; ");
    return `${cell(shown || f.package)}${f.paths.length > 3 ? ` (+${f.paths.length - 3} more)` : ""}`;
  };
  const table = [
    "| Advisory | Package | Found | Severity | Type | Vulnerable | Patched | Through | Incident |",
    "|---|---|---|---|---|---|---|---|---|",
    ...findings.map(
      (f) =>
        `| ${f.advisoryId} | \`${f.package}\` | ${f.versions.join(", ")} | ${f.severity} | ${f.dev ? "dev" : "runtime"} | ${cell(f.vulnerable)} | ${cell(f.patched ?? "none")} | ${through(f)} | ${f.incidentId ? `\`${f.incidentId}\`` : ""} |`,
    ),
  ].join("\n");
  return `${audited}\n\n${table}\n\nUse get_incident with an incident's ID for its exposure check and fix. Dev dependencies and advisories under the severity floor open no incident.`;
}
