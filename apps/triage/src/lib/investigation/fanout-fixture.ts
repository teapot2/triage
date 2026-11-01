import { exampleIncidents } from "./fixtures";
import { type Evidence, type Incident, incidentSchema, type InvestigationStep, type Thought } from "./schema";

// The pool leak as a fan-out investigation would record it, written by hand
// to build the UI against: a scout pass proposes three hypotheses, one lane
// each checks its own (supported, refuted, unclear) and a merge pass writes
// the usual report. For the dev page (/dev/fanout) and tests only: it never
// joins exampleIncidents, so it stays out of the incident list.

const base = exampleIncidents.find((i) => i.id === "inc_pool_leak")!;
const at = (ms: number) => new Date(Date.parse("2026-10-23T02:14:02Z") + ms).toISOString();

// The pool leak's evidence under the lane that gathered it. The scout keeps
// the first look's IDs; each lane's carry its lane (ev_h1_log_1).
const laneIds: Record<string, string> = {
  ev_db_activity: "ev_h1_db_1",
  ev_metric_pool: "ev_h1_metric_1",
  ev_log_stock_miss: "ev_h1_log_1",
  ev_commit_stock: "ev_h1_commit_1",
  ev_commit_flag: "ev_h1_commit_2",
  ev_source_stock: "ev_h1_source_1",
  ev_db_statements: "ev_h2_db_1",
  ev_db_locks: "ev_h2_db_2",
  ev_span_slow: "ev_h2_span_1",
  ev_metric_rps: "ev_h3_metric_1",
};
const relabel = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value).replace(/"(ev_[a-z0-9_]+)"/g, (m, id: string) => (laneIds[id] ? `"${laneIds[id]}"` : m)));

const evidenceOf = (id: string) => base.evidence.find((e) => e.id === id)!;
const evidence: Evidence[] = [
  evidenceOf("ev_metric_p95"),
  evidenceOf("ev_log_timeout"),
  ...Object.entries(laneIds).map(([from, id]) => ({ ...evidenceOf(from), id })),
  // The traffic lane's own look at the misses: many product IDs, or a few
  // hit over and over?
  {
    id: "ev_h3_log_1",
    kind: "log",
    tool: "query_logs",
    summary: "418x 'stock row missing' across 3 product IDs, 231 most of them",
    observedAt: "2026-10-23T02:13:39Z",
    service: "shopfront",
    level: "info",
    message: 'stock row missing, returning default {"product.id":231}',
    count: 418,
  },
];

function thought(id: string, lane: string, startMs: number, durationMs: number | undefined, text: string, reasoning?: string): Thought {
  return {
    id,
    lane,
    startedAt: at(startMs),
    durationMs,
    text,
    ...(reasoning && { reasoning, reasoningKind: "summary" as const }),
  };
}

function step(
  id: string,
  lane: string,
  turn: string,
  startMs: number,
  durationMs: number | undefined,
  tool: InvestigationStep["tool"],
  input: Record<string, unknown>,
  summary: string,
  evidenceIds: string[],
): InvestigationStep {
  return {
    id,
    lane,
    turn,
    tool,
    input,
    status: durationMs === undefined ? "running" : "completed",
    startedAt: at(startMs),
    durationMs,
    summary: durationMs === undefined ? undefined : summary,
    evidenceIds: durationMs === undefined ? [] : evidenceIds,
  };
}

const thoughts: Thought[] = [
  thought("th_scout_1", "scout", 0, 1900, "Look at the alert's metric and the errors first."),
  thought(
    "th_scout_2",
    "scout",
    3400,
    2100,
    "Three ways the pool could run dry: a leak, slow queries, or more traffic than it holds. Checking each in its own lane.",
    "Latency is pinned near 3000 ms, the pool's connect timeout, and the errors are pool timeouts. Something holds every connection: requests that never give one back, queries that hold one too long, or more requests than connections.",
  ),
  thought("th_h1_1", "h1", 5600, 1400, "Are the held connections busy or idle?"),
  thought("th_h2_1", "h2", 5620, 1300, "If queries are slow, pg_stat_statements and the spans will show it."),
  thought("th_h3_1", "h3", 5640, 1500, "Compare the request rate before and after 02:09."),
  thought("th_h1_2", "h1", 8200, 1200, "Idle but checked out: a leak. What changed, and which code holds them?"),
  thought("th_h2_2", "h2", 8100, 900, "Refuted: statements run under 1 ms and the held connections are idle, not running queries."),
  thought("th_h3_2", "h3", 8400, 1600, "The rate is flat, but the misses cluster on a few products. Can't tell bot traffic from real users with these tools."),
  thought("th_h1_3", "h1", 10900, 800, "Supported: getStockLevel returns before client.release() on a missing stock row, live since the flag went on."),
  thought(
    "th_merge_1",
    "merge",
    12400,
    2600,
    "H1 is supported by the source and the idle connections. H2 is refuted; H3 is unclear, but flat traffic makes it unlikely. Writing the report.",
  ),
];

const steps: InvestigationStep[] = [
  step("step_s1", "scout", "th_scout_1", 1900, 412, "query_metrics", { service: "shopfront", metrics: ["http.server.duration"], window: "30m" }, "p95 up 25x on /api/products/:id", ["ev_metric_p95"]),
  step("step_s2", "scout", "th_scout_1", 1900, 588, "query_logs", { service: "shopfront", level: "error", window: "30m", groupBy: "message" }, "412 connection timeouts since 02:09", ["ev_log_timeout"]),
  step("step_h1_1", "h1", "th_h1_1", 7000, 96, "db_diagnostics", { check: "pg_stat_activity", application: "shopfront" }, "10 connections idle for minutes", ["ev_h1_db_1"]),
  step("step_h1_2", "h1", "th_h1_1", 7000, 305, "query_metrics", { service: "shopfront", metrics: ["db.client.connection.count"], window: "30m" }, "Pool pinned at 10/10 in use since 02:09", ["ev_h1_metric_1"]),
  step("step_h2_1", "h2", "th_h2_1", 6920, 88, "db_diagnostics", { check: "pg_stat_statements", top: 5 }, "Query latency normal (mean 0.4 ms); no blocked sessions", ["ev_h2_db_1", "ev_h2_db_2"]),
  step("step_h2_2", "h2", "th_h2_1", 6920, 731, "query_traces", { service: "shopfront", route: "GET /api/products/[id]", status: "error", limit: 5 }, "Failing spans wait ~3000 ms for a pool connection, not on a query", ["ev_h2_span_1"]),
  step("step_h3_1", "h3", "th_h3_1", 7140, 290, "query_metrics", { service: "shopfront", metrics: ["http.server.request.rate"], window: "30m" }, "Request rate flat at ~14 req/s", ["ev_h3_metric_1"]),
  step("step_h1_3", "h1", "th_h1_2", 9400, 140, "deploy_history", { service: "shopfront", since: "2026-10-22T00:00:00Z" }, "Deploy of a1b9c4e at 01:58; FF_STOCK_DIRECT_QUERY turned on at 02:00", ["ev_h1_commit_1", "ev_h1_commit_2"]),
  step("step_h1_4", "h1", "th_h1_2", 9400, 31, "read_source", { file: "src/lib/stock.ts", startLine: 6, endLine: 19 }, "Early return on missing row skips client.release()", ["ev_h1_source_1"]),
  step("step_h1_5", "h1", "th_h1_2", 9400, 402, "query_logs", { service: "shopfront", query: "stock row missing", window: "30m" }, "418 'stock row missing' info logs since 01:58", ["ev_h1_log_1"]),
  step("step_h3_2", "h3", "th_h3_2", 10000, 377, "query_logs", { service: "shopfront", query: "stock row missing", groupBy: "product.id" }, "Misses on 3 product IDs, mostly 231", ["ev_h3_log_1"]),
];

const fanout = {
  leadProvider: "meta",
  leadModel: "muse-spark-1.3",
  hypotheses: [
    {
      id: "h1",
      title: "Connection leak in getStockLevel",
      claim: "A code path takes a pooled connection and never gives it back, until the pool is empty.",
      finding: "supported" as const,
      reason: "The early return on a missing stock row skips client.release(); the held connections sit idle.",
      evidenceFor: ["ev_h1_source_1", "ev_h1_db_1", "ev_h1_metric_1", "ev_h1_commit_2"],
      evidenceAgainst: [],
      steps: 5,
    },
    {
      id: "h2",
      title: "Slow product query holds connections",
      claim: "A slow query on the product route keeps connections busy.",
      finding: "refuted" as const,
      reason: "Every top statement averages under 1 ms, and the spans wait for a connection, not on a query.",
      evidenceFor: [],
      evidenceAgainst: ["ev_h2_db_1", "ev_h2_span_1"],
      steps: 2,
    },
    {
      id: "h3",
      title: "Traffic spike exceeds pool capacity",
      claim: "More concurrent requests than the pool's 10 connections.",
      finding: "unclear" as const,
      reason: "Overall traffic is flat, but the misses cluster on a few products; bot traffic on them isn't ruled out.",
      evidenceFor: ["ev_h3_log_1"],
      evidenceAgainst: ["ev_h3_metric_1"],
      steps: 2,
    },
  ],
};

// Finished: the merge wrote the report, with the pool leak's fix waiting
// for approval.
export const fanoutIncident: Incident = incidentSchema.parse({
  ...relabel(base),
  id: "inc_fanout_pool_leak",
  steps,
  thoughts,
  evidence,
  run: {
    source: "scenario:pool-leak",
    provider: "meta",
    model: "muse-spark-1.3",
    reasoningEffort: "low",
    startedAt: at(0),
    finishedAt: at(15200),
    modelSteps: 10,
    inputTokens: 41800,
    cachedInputTokens: 12600,
    outputTokens: 2900,
    fanout,
  },
});

// Mid-run: the lanes for H1 and H2 are done, H3's last call is still
// running, and there's no report yet.
export const fanoutIncidentRunning: Incident = incidentSchema.parse({
  ...fanoutIncident,
  id: "inc_fanout_pool_leak_running",
  status: "investigating",
  report: undefined,
  mitigation: undefined,
  fix: undefined,
  validation: undefined,
  approval: undefined,
  thoughts: thoughts.filter((t) => t.lane !== "merge"),
  steps: steps.map((s) => (s.id === "step_h3_2" ? { ...s, status: "running", durationMs: undefined, summary: undefined, evidenceIds: [] } : s)),
  evidence: evidence.filter((e) => e.id !== "ev_h3_log_1"),
  run: {
    ...fanoutIncident.run,
    finishedAt: undefined,
    fanout: {
      ...fanout,
      hypotheses: fanout.hypotheses.map((h) =>
        h.id === "h3" ? { id: h.id, title: h.title, claim: h.claim, evidenceFor: [], evidenceAgainst: [] } : h,
      ),
    },
  },
});
