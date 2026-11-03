import { tool } from "ai";
import { z } from "zod";
import type { EvidenceDraft, InvestigationRecorder, StepRecorder } from "./recorder";
import {
  type Evidence,
  findUnknownEvidenceIds,
  investigationReportSchema,
  type MetricPoint,
  reportProblems,
  reportSummarySchema,
  type ToolName,
} from "./schema";
import type { TelemetrySource } from "./source";
import { errorMessage } from "../errors";

interface ToolRun {
  summary: string;
  evidence: EvidenceDraft[];
  services?: string[];
}

const windowMinutes = z
  .number()
  .int()
  .min(1)
  .max(180)
  .optional()
  .describe("Look-back window in minutes from the alert time (default 30)");

// The investigation's tools: seven read-only ones, plus submit_report for
// the investigation itself. A question gets only the read-only seven
// ({ submit: false }), recorded on its own StepRecorder.
export function createInvestigationTools(
  source: TelemetrySource,
  recorder: InvestigationRecorder,
): ReturnType<typeof readOnlyTools> & { submit_report: ReturnType<typeof submitReportTool> };
export function createInvestigationTools(
  source: TelemetrySource,
  recorder: StepRecorder,
  opts: { submit: false },
): ReturnType<typeof readOnlyTools>;
export function createInvestigationTools(
  source: TelemetrySource,
  recorder: StepRecorder | InvestigationRecorder,
  opts: { submit?: boolean } = {},
) {
  const tools = readOnlyTools(source, recorder);
  if (opts.submit === false) return tools;
  return { ...tools, submit_report: submitReportTool(source, recorder as InvestigationRecorder) };
}

function readOnlyTools(source: TelemetrySource, recorder: StepRecorder) {
  const description = source.describe();
  const serviceNames = description.services.map((s) => s.name);
  const metricList = description.metrics
    .map((m) => `- ${m.name} [${m.service}, ${m.unit}]: ${m.description}`)
    .join("\n");
  // An endpoint Triage only checks from outside has none of these behind
  // it; one line says so instead of an empty result that reads like
  // "nothing wrong in the database".
  const external = description.external;
  const notConnected = (what: string): ToolRun => ({
    summary: `No ${what} connected: ${external!.url} is an external endpoint, known only from Triage's own checks`,
    evidence: [],
  });

  // Wraps a tool body so every call is a recorded step with evidence IDs,
  // and the model only ever sees compact, ID-tagged results.
  function recorded<I extends Record<string, unknown>>(name: ToolName, run: (input: I) => Promise<ToolRun>) {
    return async (input: I, { toolCallId }: { toolCallId: string }) => {
      recorder.startStep(toolCallId, name, input);
      try {
        const result = await run(input);
        for (const s of result.services ?? []) recorder.queriedServices.add(s);
        const evidence = recorder.completeStep(toolCallId, name, result.summary, result.evidence);
        return { summary: result.summary, evidence: evidence.map(forModel) };
      } catch (err) {
        const message = errorMessage(err);
        recorder.failStep(toolCallId, message);
        throw err;
      }
    };
  }

  return {
    query_metrics: tool({
      description: `Fetch time series for one or more metrics. Available metrics:\n${metricList}`,
      inputSchema: z.object({
        metrics: z.array(z.string()).min(1).max(4).describe("Exact metric names from the list"),
        windowMinutes,
      }),
      execute: recorded("query_metrics", async ({ metrics, windowMinutes = 30 }) => {
        const found = await Promise.all(metrics.map((name) => source.queryMetric({ name, windowMinutes })));
        const missing = metrics.filter((_, i) => !found[i]);
        if (missing.length === metrics.length) {
          throw new Error(`Unknown metric(s): ${missing.join(", ")}. Use names from the tool description.`);
        }
        const evidence: EvidenceDraft[] = found.flatMap((m) => {
          if (!m || m.points.length === 0) return [];
          const { baseline, observed, peak } = summarizeSeries(m.points);
          return [
            {
              kind: "metric" as const,
              summary: `${m.name}: baseline ${baseline} -> now ${observed} ${m.unit} (peak ${peak.value} at ${hhmm(peak.t)})`,
              metric: m.name,
              unit: m.unit,
              baseline,
              observed,
              series: m.points,
            },
          ];
        });
        const services = found.flatMap((m) => (m ? [m.service] : []));
        const note = missing.length ? `; unknown: ${missing.join(", ")}` : "";
        return { summary: `${evidence.length} series${note}`, evidence, services };
      }),
    }),

    query_logs: tool({
      description:
        "Search log records grouped by message template, most frequent first. Filter by service, minimum level and substring.",
      inputSchema: z.object({
        service: z.enum(serviceNames).optional(),
        minLevel: z.enum(["debug", "info", "warn", "error"]).optional(),
        contains: z.string().optional().describe("Case-insensitive substring of the message"),
        windowMinutes,
      }),
      execute: recorded("query_logs", async ({ service, minLevel, contains, windowMinutes = 30 }) => {
        const groups = (await source.queryLogs({ service, minLevel, contains, windowMinutes })).slice(0, 8);
        const evidence: EvidenceDraft[] = groups.map((g) => ({
          kind: "log",
          summary: `${g.count}x ${g.level} '${truncate(g.message, 70)}' (${hhmm(g.firstSeen) === hhmm(g.lastSeen) ? `at ${hhmm(g.lastSeen)}` : `${hhmm(g.firstSeen)} to ${hhmm(g.lastSeen)}`})`,
          observedAt: g.lastSeen,
          service: g.service,
          level: g.level,
          message: g.message,
          count: g.count,
          traceId: g.traceId,
        }));
        return {
          summary: groups.length ? `${groups.length} log groups` : "No matching log records",
          evidence,
          services: service ? [service] : groups.map((g) => g.service),
        };
      }),
    }),

    query_traces: tool({
      description: "Find spans, slowest first. Filter by service, route, status and minimum duration.",
      inputSchema: z.object({
        service: z.enum(serviceNames).optional(),
        route: z.string().optional().describe("HTTP route, e.g. /api/products/[id]"),
        status: z.enum(["ok", "error"]).optional(),
        minDurationMs: z.number().optional(),
        limit: z.number().int().min(1).max(10).optional(),
        windowMinutes,
      }),
      // Windowed like the logs: slowest first over all that's kept would
      // bring back an earlier outage's spans ahead of this one's.
      execute: recorded("query_traces", async ({ service, route, status, minDurationMs, limit = 5, windowMinutes = 30 }) => {
        const spans = await source.queryTraces({ service, route, status, minDurationMs, windowMinutes, limit });
        const evidence: EvidenceDraft[] = spans.map((s) => ({
          kind: "span",
          summary: `${s.service} ${s.name} ${Math.round(s.durationMs)} ms ${s.status} at ${hhmm(s.startedAt)}`,
          observedAt: s.startedAt,
          service: s.service,
          traceId: s.traceId,
          name: s.name,
          durationMs: s.durationMs,
          status: s.status,
          attributes: s.attributes,
        }));
        return {
          summary: spans.length ? `${spans.length} spans` : "No matching spans",
          evidence,
          services: service ? [service] : spans.map((s) => s.service),
        };
      }),
    }),

    db_diagnostics: tool({
      description:
        "Inspect Postgres: 'activity' (pg_stat_activity: connection states and how long), 'locks' (blocked sessions), 'slow_queries' (pg_stat_statements: each statement's calls and time in the window before the alert, beside its totals since the statistics were reset).",
      inputSchema: z.object({ check: z.enum(["activity", "locks", "slow_queries"]) }),
      execute: recorded("db_diagnostics", async ({ check }) => {
        if (external) return notConnected("database");
        const result = await source.dbDiagnostics(check);
        const count = result.rows.length === 0 ? `${check}: no rows` : `${check}: ${result.rows.length} rows`;
        const summary = result.note ? `${count}; ${result.note}` : count;
        return {
          summary,
          evidence: [{ kind: "db", summary, query: result.query, rows: result.rows }],
          services: ["postgres"],
        };
      }),
    }),

    read_source: tool({
      description: "Read an application source file, optionally a line range. Paths are relative to the app root.",
      inputSchema: z.object({
        path: z.string().describe("e.g. src/db/client.ts"),
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional(),
      }),
      execute: recorded("read_source", async ({ path, startLine = 1, endLine }) => {
        if (external) return notConnected("source code");
        const file = await source.readSource(path);
        if (!file) {
          const files = await source.listSourceFiles();
          throw new Error(`File not found: ${path}. Known files: ${files.join(", ")}`);
        }
        const lines = file.content.replace(/\n$/, "").split("\n");
        const end = Math.min(endLine ?? lines.length, lines.length);
        const code = lines.slice(startLine - 1, end).join("\n");
        const summary = `${file.path} lines ${startLine}-${end}`;
        return {
          summary,
          evidence: [{ kind: "source", summary, file: file.path, startLine, code }],
          services: [recorder.service],
        };
      }),
    }),

    git_log: tool({
      description: "List recent commits, newest first, optionally only those touching a path.",
      inputSchema: z.object({
        path: z.string().optional(),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      execute: recorded("git_log", async ({ path, limit = 10 }) => {
        if (external) return notConnected("git history");
        const commits = await source.gitLog({ path, limit });
        const evidence: EvidenceDraft[] = commits.map((c) => ({
          kind: "commit",
          summary: `${c.sha} '${c.message}' by ${c.author} at ${hhmm(c.committedAt)}`,
          observedAt: c.committedAt,
          sha: c.sha,
          author: c.author,
          message: c.message,
          files: c.files,
        }));
        return {
          summary: `${commits.length} commits`,
          evidence,
          services: [recorder.service],
        };
      }),
    }),

    deploy_history: tool({
      description: "List deploys and runtime config changes (e.g. feature flags flipped), newest first.",
      inputSchema: z.object({
        service: z.enum(serviceNames).optional(),
        sinceMinutes: z.number().int().min(1).max(60 * 24 * 7).optional().describe("Default 1440 (24 h)"),
      }),
      execute: recorded("deploy_history", async ({ service, sinceMinutes = 1440 }) => {
        if (external) return notConnected("deploy history");
        const [deploys, commits] = await Promise.all([
          source.deployHistory({ service, sinceMinutes }),
          source.gitLog({ limit: 50 }),
        ]);
        const evidence: EvidenceDraft[] = deploys.map((d) => {
          const c = commits.find((x) => x.sha === d.sha);
          // A rollback's own message says what happened; the commit's would
          // make it read like the deploy it undid.
          const message = d.kind === "rollback" ? d.message : (c?.message ?? d.message);
          const what =
            d.kind === "config"
              ? `Config change on ${d.service}`
              : d.kind === "rollback"
                ? `Rolled back ${d.sha} on ${d.service}`
                : `Deployed ${d.sha} to ${d.service}`;
          return {
            kind: "commit",
            summary: `${what} at ${hhmm(d.deployedAt)}${message ? `: '${message}'` : ""}`,
            observedAt: d.deployedAt,
            sha: d.sha,
            author: c?.author ?? "unknown",
            message: message ?? "(commit not found)",
            files: c?.files ?? [],
            deployKind: d.kind ?? "deploy",
            ...(d.branch ? { branch: d.branch } : {}),
          };
        });
        return {
          summary: deploys.length ? `${deploys.length} deploys` : "No deploys in window",
          evidence,
          services: service ? [service] : deploys.map((d) => d.service),
        };
      }),
    }),

  };
}

function submitReportTool(source: TelemetrySource, recorder: InvestigationRecorder) {
  const serviceNames = source.describe().services.map((s) => s.name);
  return tool({
    description:
      "Submit the final report. It is checked: every cited evidence ID must exist, a root_cause verdict needs at least 3 hypotheses and must name a fault (if nothing is wrong, the verdict is healthy), and every service in the dependency path must have been queried. If it is rejected, fix the listed problems (investigate more if needed) and submit again.",
    // exposure is the dependency stage's (dependencies/exposure.ts): offered
    // here, models fill it in on telemetry incidents too.
    inputSchema: investigationReportSchema.omit({ servicesQueried: true, exposure: true }).extend({ summary: reportSummarySchema }),
    execute: async (input) => {
      const report = { ...input, servicesQueried: [...recorder.queriedServices].sort() };
      const unknown = findUnknownEvidenceIds(report, recorder.evidence);
      const unqueried = serviceNames.filter((s) => !recorder.queriedServices.has(s));
      const problems = [
        ...reportProblems(report),
        ...(unknown.length ? [`unknown evidence IDs cited: ${unknown.join(", ")}`] : []),
        ...unqueried.map((s) => `service not queried yet: ${s}`),
      ];
      if (problems.length > 0) {
        recorder.rejectedReports += 1;
        return { accepted: false, problems };
      }
      recorder.update({ report });
      return { accepted: true };
    },
  });
}

// What the model sees for each evidence item: enough to reason with, short
// enough to keep the context small.
export function forModel(e: Evidence) {
  const base = { id: e.id, summary: e.summary };
  switch (e.kind) {
    case "log":
      return { ...base, service: e.service, level: e.level, message: e.message, count: e.count, traceId: e.traceId };
    case "span":
      return { ...base, traceId: e.traceId, attributes: e.attributes };
    case "metric":
      return { ...base, unit: e.unit, points: downsample(e.series, 12) };
    case "db":
      return { ...base, query: e.query, rows: e.rows };
    case "source":
      return {
        ...base,
        code: e.code
          .split("\n")
          .map((line, i) => `${String(e.startLine + i).padStart(3)}  ${line}`)
          .join("\n"),
      };
    case "commit":
      return { ...base, files: e.files };
    case "web":
      return { ...base, url: e.url };
    case "incident":
      return { ...base, incidentId: e.incidentId, verdict: e.verdict };
  }
}

export function summarizeSeries(points: MetricPoint[]) {
  const head = points.slice(0, Math.max(1, Math.floor(points.length / 2)));
  const sorted = head.map((p) => p.value).sort((a, b) => a - b);
  const baseline = round(sorted[Math.floor(sorted.length / 2)]);
  const observed = round(points[points.length - 1].value);
  const peak = points.reduce((a, b) => (b.value > a.value ? b : a));
  return { baseline, observed, peak: { t: peak.t, value: round(peak.value) } };
}

function downsample(points: MetricPoint[], n: number): string[] {
  const step = Math.max(1, Math.ceil(points.length / n));
  const picked = points.filter((_, i) => i % step === 0 || i === points.length - 1);
  return picked.map((p) => `${hhmm(p.t)}=${round(p.value)}`);
}

function hhmm(iso: string): string {
  return iso.slice(11, 16);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
