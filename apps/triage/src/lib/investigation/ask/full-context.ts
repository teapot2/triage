import { plainAnswer } from "./rules";
import { incidentBlock } from "../context";
import type { Evidence, Incident } from "../schema";
import type { TelemetrySource } from "../source";
import { summarizeSeries } from "../tools";

// A full-context question's bundle: everything Triage holds on the service,
// read into one prompt instead of fetched by tools. Shopfront's source in
// 40-line chunks, its history with every diff, the deploy history, every
// earlier incident's report, then the telemetry up to the alert: metrics,
// log groups, and spans newest first until the budget is spent.
//
// Each item carries an evidence ID the answer cites (ev_ctx_source_3_2,
// ev_ctx_commit_ab12cd3, ev_ctx_incident_4, ...). The IDs and the text
// depend only on the incident and what the source holds up to its alert, so
// a second question on the incident sends the same bundle, and Meta serves
// it from the prompt cache. Only the items an answer cites are saved, as
// the question's evidence.

// The model a full-context answer runs on by default; full-context-model.ts
// keeps an Ask stage on open weights (Muse Spark Open) on its own model.
export const FULL_CONTEXT_MODEL = { provider: "meta", model: "muse-wonder-1.0" } as const;
// The context window a full-context model needs: Wonder's and Muse Spark
// Open's 1,048,576.
export const FULL_CONTEXT_WINDOW = 1_048_576;
// Of that window, what a full-context prompt may fill: the rest is for the
// reasoning and the answer.
export const FULL_CONTEXT_TOKENS = 800_000;
// For budgeting only. Code and JSON run nearer 3 characters a token than
// the 4 of English prose, so 3 errs on the side of a prompt that fits.
export const CHARS_PER_TOKEN = 3;

const CHUNK_LINES = 40;
// One commit's diff past this is cut: a generated file can be huge.
const MAX_PATCH_CHARS = 40_000;
const COMMITS = 500;
const WEEK_MINUTES = 7 * 24 * 60;
const DAY_MINUTES = 24 * 60;
const METRIC_MINUTES = 6 * 60;
const MAX_SPANS = 100_000;

export interface BundleParts {
  source: string;
  changes: string;
  incidents: string;
  telemetry: string;
}

export interface FullContext {
  parts: BundleParts;
  // Every citable item by ID, as it would be saved once cited.
  items: Map<string, Evidence>;
  // What the telemetry covers, for the prompt and the step's summary.
  spans: { included: number; total: number; oldest?: string };
}

export const estimateTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);

export const bundleText = (parts: BundleParts) => parts.source + parts.changes + parts.incidents + parts.telemetry;

const hhmm = (iso: string) => iso.slice(11, 16);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

// The bundle for a question on `incident`, its telemetry cut to fit
// `budget` tokens in all. `others` are the earlier incidents whose reports
// go in (the caller lists them from the store).
export async function buildContext(
  incident: Incident,
  source: TelemetrySource,
  others: Incident[],
  budget: number,
): Promise<FullContext> {
  const items = new Map<string, Evidence>();
  const add = (e: Evidence) => items.set(e.id, e);

  const [source_, changes] = await Promise.all([sourcePart(source, add), changesPart(source, add)]);
  const incidents = incidentsPart(incident, others, add);
  const fixed = estimateTokens(source_ + changes + incidents);
  const { text: telemetry, spans } = await telemetryPart(source, add, Math.max(0, budget - fixed));
  return { parts: { source: source_, changes, incidents, telemetry }, items, spans };
}

async function sourcePart(source: TelemetrySource, add: (e: Evidence) => void): Promise<string> {
  const files = await source.listSourceFiles();
  const blocks: string[] = [];
  for (const [i, path] of files.entries()) {
    const file = await source.readSource(path);
    if (!file) continue;
    const lines = file.content.replace(/\n$/, "").split("\n");
    for (let start = 0, c = 1; start < lines.length; start += CHUNK_LINES, c++) {
      const id = `ev_ctx_source_${i + 1}_${c}`;
      const chunk = lines.slice(start, start + CHUNK_LINES);
      const end = start + chunk.length;
      const summary = `${file.path} lines ${start + 1}-${end}`;
      add({ id, tool: "read_source", kind: "source", summary, file: file.path, startLine: start + 1, code: chunk.join("\n") });
      const numbered = chunk.map((line, n) => `${String(start + n + 1).padStart(4)}  ${line}`).join("\n");
      blocks.push(`### ${id} · ${summary}\n${numbered}`);
    }
  }
  return section("source", "The service's source code: every file Triage may read, in 40-line chunks with line numbers.", blocks);
}

async function changesPart(source: TelemetrySource, add: (e: Evidence) => void): Promise<string> {
  const [commits, deploys] = await Promise.all([
    source.gitLog({ limit: COMMITS, patch: true }),
    source.deployHistory({ sinceMinutes: WEEK_MINUTES }),
  ]);
  const blocks: string[] = [];
  for (const c of commits) {
    const id = `ev_ctx_commit_${c.sha.toLowerCase()}`;
    const summary = `${c.sha} '${c.message}' by ${c.author} at ${c.committedAt}`;
    add({ id, tool: "git_log", kind: "commit", summary, observedAt: c.committedAt, sha: c.sha, author: c.author, message: c.message, files: c.files });
    const patch = c.patch ?? "";
    const diff = patch.length > MAX_PATCH_CHARS ? `${patch.slice(0, MAX_PATCH_CHARS)}\n[diff cut at ${MAX_PATCH_CHARS} characters]` : patch;
    blocks.push(`### ${id} · ${summary}\nFiles: ${c.files.join(", ") || "(none listed)"}${diff ? `\n${diff}` : ""}`);
  }
  for (const [i, d] of deploys.entries()) {
    const id = `ev_ctx_commit_deploy_${i + 1}`;
    const what = d.kind === "config" ? "Config change" : d.kind === "rollback" ? "Rollback" : "Deploy";
    const summary = `${what} ${d.sha} on ${d.service} at ${d.deployedAt}${d.message ? `: '${d.message}'` : ""}`;
    const commit = commits.find((c) => c.sha === d.sha);
    add({
      id,
      tool: "deploy_history",
      kind: "commit",
      summary,
      observedAt: d.deployedAt,
      sha: d.sha,
      author: commit?.author ?? "unknown",
      message: d.message ?? commit?.message ?? "(commit not found)",
      files: commit?.files ?? [],
      deployKind: d.kind ?? "deploy",
      ...(d.branch ? { branch: d.branch } : {}),
    });
    blocks.push(`### ${id} · ${summary}`);
  }
  return section(
    "changes",
    "The service's git history, newest first, each commit with its diff; then the deploys, config changes and rollbacks of the week before the alert, newest first.",
    blocks,
  );
}

function incidentsPart(incident: Incident, others: Incident[], add: (e: Evidence) => void): string {
  const earlier = others
    .filter((o) => o.id !== incident.id && o.service === incident.service && o.report)
    .sort((a, b) => a.detectedAt.localeCompare(b.detectedAt) || a.id.localeCompare(b.id));
  const blocks = earlier.map((o, i) => {
    const id = `ev_ctx_incident_${i + 1}`;
    const verdict = verdictLine(o);
    add({
      id,
      tool: "full_context",
      kind: "incident",
      summary: `${o.title} · ${o.detectedAt.slice(0, 16).replace("T", " ")} UTC`,
      observedAt: o.detectedAt,
      incidentId: o.id,
      title: o.title,
      ...(verdict && { verdict }),
    });
    // Their own evidence IDs mean nothing here, so the citations go.
    return `### ${id} · ${o.title} · detected ${o.detectedAt} · ${o.status}\n${plainAnswer(incidentBlock(o, undefined))}`;
  });
  return section("incidents", "Every earlier incident on this service that has a report, oldest first: what was found and done.", blocks);
}

function verdictLine(o: Incident): string | undefined {
  const v = o.report?.verdict;
  if (v?.kind === "root_cause") return o.report!.hypotheses.find((h) => h.id === v.hypothesisId)?.title;
  if (v?.kind === "healthy") return "Healthy";
  if (v?.kind === "inconclusive") return "Inconclusive";
  return undefined;
}

// Metrics, then log groups, then spans newest first, each line kept while
// it fits the budget; the first that doesn't ends the part.
async function telemetryPart(
  source: TelemetrySource,
  add: (e: Evidence) => void,
  budget: number,
): Promise<{ text: string; spans: FullContext["spans"] }> {
  const described = source.describe();
  const [metrics, logs, traces] = await Promise.all([
    Promise.all(described.metrics.map((m) => source.queryMetric({ name: m.name, windowMinutes: METRIC_MINUTES }))),
    source.queryLogs({ windowMinutes: DAY_MINUTES }),
    source.queryTraces({ windowMinutes: DAY_MINUTES, limit: MAX_SPANS }),
  ]);
  const spans = [...traces].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.traceId.localeCompare(b.traceId));

  const lines: string[] = [];
  let left = budget - estimateTokens(sectionFrame("telemetry", telemetryIntro(described.now)));
  const fits = (line: string) => {
    const cost = estimateTokens(line) + 1;
    if (cost > left) return false;
    left -= cost;
    lines.push(line);
    return true;
  };

  let full = false;
  for (const [i, m] of metrics.entries()) {
    if (!m || m.points.length === 0) continue;
    const id = `ev_ctx_metric_${i + 1}`;
    const { baseline, observed, peak } = summarizeSeries(m.points);
    const summary = `${m.name}: baseline ${baseline} -> ${observed} ${m.unit} (peak ${peak.value} at ${hhmm(peak.t)})`;
    const points = m.points.map((p) => `${hhmm(p.t)}=${Math.round(p.value * 100) / 100}`).join(" ");
    if (!fits(`### ${id} · ${m.name} [${m.service}, ${m.unit}] per minute: ${oneLine(m.description)}\n${points}`)) {
      full = true;
      break;
    }
    add({ id, tool: "query_metrics", kind: "metric", summary, metric: m.name, unit: m.unit, baseline, observed, series: m.points });
  }

  if (!full) {
    for (const [i, g] of logs.entries()) {
      const id = `ev_ctx_log_${i + 1}`;
      const when = g.firstSeen === g.lastSeen ? `at ${g.lastSeen}` : `${g.firstSeen} to ${g.lastSeen}`;
      if (!fits(`${id} · ${g.count}x ${g.level} ${g.service} ${when}${g.traceId ? ` trace ${g.traceId}` : ""} · ${oneLine(g.message)}`)) {
        full = true;
        break;
      }
      add({
        id,
        tool: "query_logs",
        kind: "log",
        summary: `${g.count}x ${g.level} '${oneLine(g.message).slice(0, 70)}' (${when})`,
        observedAt: g.lastSeen,
        service: g.service,
        level: g.level,
        message: g.message,
        count: g.count,
        traceId: g.traceId,
      });
    }
  }

  let included = 0;
  if (!full) {
    for (const [i, s] of spans.entries()) {
      const id = `ev_ctx_span_${i + 1}`;
      const attrs = JSON.stringify(s.attributes);
      if (!fits(`${id} · ${s.startedAt} ${s.service} ${s.name} ${Math.round(s.durationMs)} ms ${s.status} trace ${s.traceId} ${attrs}`)) break;
      add({
        id,
        tool: "query_traces",
        kind: "span",
        summary: `${s.service} ${s.name} ${Math.round(s.durationMs)} ms ${s.status} at ${hhmm(s.startedAt)}`,
        observedAt: s.startedAt,
        service: s.service,
        traceId: s.traceId,
        name: s.name,
        durationMs: s.durationMs,
        status: s.status,
        attributes: s.attributes,
      });
      included++;
    }
  }

  const oldest = included > 0 ? spans[included - 1].startedAt : undefined;
  const intro = `${telemetryIntro(described.now)} Spans: the ${included} newest of ${spans.length} in the day before the alert${oldest ? `, back to ${oldest}` : ""}.`;
  return { text: section("telemetry", intro, lines), spans: { included, total: spans.length, oldest } };
}

const telemetryIntro = (now: string) =>
  `Telemetry up to the alert (${now}): every metric per minute over the 6 hours before it, log records grouped by message over the day before it, then spans newest first.`;

const sectionFrame = (name: string, intro: string) => `\n<${name}>\n${intro}\n\n</${name}>\n`;

function section(name: string, intro: string, blocks: string[]): string {
  return `\n<${name}>\n${intro}\n\n${blocks.length ? blocks.join("\n\n") : "(none)"}\n</${name}>\n`;
}

// Kept for an hour per incident, so a follow-up sends the same bundle
// without reading the telemetry again.
const CACHE_MS = 60 * 60_000;
const cache = new Map<string, { at: number; budget: number; context: Promise<FullContext> }>();

export function cachedContext(key: string, budget: number, build: () => Promise<FullContext>): Promise<FullContext> {
  const hit = cache.get(key);
  if (hit && hit.budget === budget && Date.now() - hit.at < CACHE_MS) return hit.context;
  const context = build();
  cache.set(key, { at: Date.now(), budget, context });
  // A failed build isn't kept.
  context.catch(() => cache.delete(key));
  return context;
}
