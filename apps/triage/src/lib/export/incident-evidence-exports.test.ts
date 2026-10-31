import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { exampleIncidents } from "../investigation/fixtures";
import type { Evidence, Incident, Question } from "../investigation/schema";
import { fixPatch, traceRows } from "./datasets/incident";
import { serialize } from "./serialize";

// The incident page's exports (the record, its evidence by kind, the
// investigation's trace, the fix's patch and the Ask answers) through the
// route, on a temp working directory so .data is ours. The store resolves
// its folder when it loads, so the route is imported after the chdir.
const cwd = process.cwd();
let dir: string;
let GET: typeof import("../../app/api/export/[dataset]/route").GET;

// A question's own evidence: one of each kind, a metric with no points and
// a query that returned no rows among them.
const askEvidence: Evidence[] = [
  {
    id: "ev_q1_log_1",
    kind: "log",
    tool: "query_logs",
    summary: "3x 'pool exhausted' after the flag change",
    observedAt: "2026-10-23T02:31:10Z",
    service: "shopfront",
    level: "warn",
    message: "=pool exhausted, waiting",
  },
  {
    id: "ev_q1_span_1",
    kind: "span",
    tool: "query_traces",
    summary: "pool.connect waited 2990 ms",
    service: "shopfront",
    traceId: "aa11",
    name: "pool.connect",
    durationMs: 2990,
    status: "error",
    attributes: { "db.system.name": "postgresql", retried: false },
  },
  {
    id: "ev_q1_metric_1",
    kind: "metric",
    tool: "query_metrics",
    summary: "No pool wait samples recorded",
    metric: "db.client.connection.wait_time",
    unit: "ms",
    baseline: 0,
    observed: 0,
    series: [],
  },
  {
    id: "ev_q1_db_1",
    kind: "db",
    tool: "db_diagnostics",
    summary: "No sessions waiting on a lock",
    query: "SELECT pid FROM pg_locks WHERE NOT granted",
    rows: [],
  },
];

const answered: Question = {
  id: "q_1",
  text: "Why did the pool\nrun out?",
  askedAt: "2026-10-23T02:31:00.000Z",
  answeredAt: "2026-10-23T02:31:40.000Z",
  status: "answered",
  answer: "A missing stock row returns early without releasing the client [ev_log_timeout], so pool.connect waits [ev_q1_span_1]. See also [ev_gone].",
  citedIds: ["ev_log_timeout", "ev_q1_span_1"],
  unknownIds: ["ev_gone"],
  steps: [],
  evidence: askEvidence,
  mode: "tools",
  provider: "meta",
  model: "muse-spark-1.3",
};

const failed: Question = {
  id: "q_2",
  text: "Did the deploy at 01:58 change the pool size?",
  askedAt: "2026-10-23T02:35:00.000Z",
  answeredAt: "2026-10-23T02:35:05.000Z",
  status: "failed",
  error: "The model stopped responding",
  answer: "",
  citedIds: [],
  unknownIds: [],
  steps: [],
  evidence: [],
  mode: "tools",
  model: "muse-spark-1.3",
};

// The pool leak, with every kind of evidence, a fix, a recorded run with
// its thinking, and two questions.
function full(): Incident {
  const incident = structuredClone(exampleIncidents.find((i) => i.id === "inc_pool_leak")!);
  return {
    ...incident,
    id: "inc_export_full",
    run: {
      source: "scenario:pool-leak",
      provider: "meta",
      model: "muse-spark-1.3",
      startedAt: "2026-10-23T02:14:02.000Z",
      finishedAt: "2026-10-23T02:15:02.000Z",
      modelSteps: 4,
      inputTokens: 18200,
      outputTokens: 940,
    },
    thoughts: [
      // Out of order on purpose: the trace sorts by time.
      { id: "th_3", startedAt: "2026-10-23T02:14:11Z", durationMs: 900, text: "Submitting the report." },
      { id: "th_1", startedAt: "2026-10-23T02:14:02Z", durationMs: 800, reasoning: "Start with the alert's metric.", reasoningKind: "summary" },
      // The same moment as step_2 and step_3, which it led to.
      { id: "th_2", startedAt: "2026-10-23T02:14:04Z", durationMs: 0, reasoning: "Errors next." },
    ],
    questions: [answered, failed],
  };
}

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "triage-incident-page-export-"));
  process.chdir(dir);
  ({ GET } = await import("../../app/api/export/[dataset]/route"));
  const { saveIncident } = await import("../investigation/store");
  await saveIncident(full());
  // Nothing but the alert: no steps, evidence, fix or questions.
  const bare = structuredClone(exampleIncidents.find((i) => i.id === "inc_control")!);
  await saveIncident({ ...bare, id: "inc_export_bare", steps: [], evidence: [], thoughts: undefined, run: undefined, fix: undefined, questions: [] });
});
after(async () => {
  process.chdir(cwd);
  // Windows may still hold a just-renamed file for a moment.
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

const get = (dataset: string, query: string) =>
  GET(new Request(`http://localhost:3024/api/export/${dataset}?${query}`), { params: Promise.resolve({ dataset }) });

const BOM = "﻿";
const csvLines = async (res: Response) => {
  const body = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
  assert.ok(body.startsWith(BOM), "CSV starts with a BOM");
  return body.slice(1).split("\r\n").filter(Boolean);
};
const json = async (res: Response) => {
  assert.equal(res.status, 200);
  return (await res.json()) as { subject: unknown; count: number; rows: Record<string, unknown>[] };
};
const filename = (res: Response) => /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1];
const STAMP = /\d{4}-\d{2}-\d{2}T\d{4}Z/.source;

describe("GET /api/export/incident", () => {
  it("is the whole stored record, as the store returns it", async () => {
    const res = await get("incident", "format=json&id=inc_export_full");
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    assert.match(filename(res) ?? "", new RegExp(`^incident_p95-latency-and-500s-on-get-api-products_${STAMP}\\.json$`));
    const file = await json(res);
    assert.deepEqual(file.subject, { kind: "incident", id: "inc_export_full", name: "p95 latency and 500s on GET /api/products/:id" });
    assert.equal(file.count, 1);
    const { getIncident } = await import("../investigation/store");
    assert.deepEqual(file.rows[0], JSON.parse(JSON.stringify(await getIncident("inc_export_full"))));
  });

  // Keys and webhook URLs live in settings; an incident field that held one
  // would leave with every export of the record.
  it("holds no field named like a secret", async () => {
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        for (const [k, child] of Object.entries(v)) {
          keys.add(k);
          walk(child);
        }
      }
    };
    walk((await json(await get("incident", "format=json&id=inc_export_full"))).rows[0]);
    assert.deepEqual([...keys].filter((k) => /^(api_?)?key$|secret|password|webhook|authorization|cookie|(access|auth|api|bearer|refresh)_?token/i.test(k)), []);
  });

  it("serves a bundled example too", async () => {
    const file = await json(await get("incident", "format=json&id=inc_pool_leak"));
    assert.equal((file.rows[0] as { id: string }).id, "inc_pool_leak");
  });
});

describe("GET /api/export/evidence-logs", () => {
  it("writes every log, the investigation's then each question's, with its source", async () => {
    const res = await get("evidence-logs", "format=csv&id=inc_export_full");
    assert.equal(res.status, 200);
    assert.deepEqual(await csvLines(res), [
      "evidence_id,source,observed_at,service,level,message,trace_id,count,summary",
      "ev_log_timeout,investigation,2026-10-23T02:13:41Z,shopfront,error,Error: timeout exceeded when trying to connect,4bf92f3577b34da6a3ce929d0e0e4736,412,412x 'timeout exceeded when trying to connect' since 02:09",
      `ev_log_stock_miss,investigation,2026-10-23T02:13:39Z,shopfront,info,"stock row missing, returning default {""product.id"":231}",,418,"418x 'stock row missing, returning default' since 01:58"`,
      // A message a spreadsheet would run as a formula is guarded.
      "ev_q1_log_1,q_1,2026-10-23T02:31:10Z,shopfront,warn,\"'=pool exhausted, waiting\",,,3x 'pool exhausted' after the flag change",
    ]);
  });

  it("writes the message as it was in JSON and NDJSON", async () => {
    const file = await json(await get("evidence-logs", "format=json&id=inc_export_full"));
    assert.deepEqual(file.rows[2], {
      evidence_id: "ev_q1_log_1",
      source: "q_1",
      observed_at: "2026-10-23T02:31:10Z",
      service: "shopfront",
      level: "warn",
      message: "=pool exhausted, waiting",
      trace_id: null,
      count: null,
      summary: "3x 'pool exhausted' after the flag change",
    });
    const res = await get("evidence-logs", "format=ndjson&id=inc_export_full");
    assert.equal(res.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
    const lines = (await res.text()).split("\n");
    assert.equal(lines.pop(), "");
    assert.deepEqual(lines.map((l) => JSON.parse(l).evidence_id), ["ev_log_timeout", "ev_log_stock_miss", "ev_q1_log_1"]);
  });
});

describe("GET /api/export/evidence-spans", () => {
  it("writes the attributes as JSON text in CSV", async () => {
    assert.deepEqual(await csvLines(await get("evidence-spans", "format=csv&id=inc_export_full")), [
      "evidence_id,source,observed_at,service,trace_id,name,duration_ms,status,attributes",
      `ev_span_slow,investigation,2026-10-23T02:13:41Z,shopfront,4bf92f3577b34da6a3ce929d0e0e4736,GET /api/products/[id],3004,error,"{""http.route"":""/api/products/[id]"",""http.response.status_code"":500,""db.client.connection.wait_time_ms"":3000,""db.system.name"":""postgresql"",""error.type"":""Error""}"`,
      `ev_q1_span_1,q_1,,shopfront,aa11,pool.connect,2990,error,"{""db.system.name"":""postgresql"",""retried"":false}"`,
    ]);
  });

  it("writes them as an object in JSON", async () => {
    const file = await json(await get("evidence-spans", "format=json&id=inc_export_full"));
    assert.deepEqual(file.rows[1], {
      evidence_id: "ev_q1_span_1",
      source: "q_1",
      observed_at: null,
      service: "shopfront",
      trace_id: "aa11",
      name: "pool.connect",
      duration_ms: 2990,
      status: "error",
      attributes: { "db.system.name": "postgresql", retried: false },
    });
  });
});

describe("GET /api/export/evidence-metrics", () => {
  it("writes one row per point, and a metric with none as one row", async () => {
    const [header, ...rows] = await csvLines(await get("evidence-metrics", "format=csv&id=inc_export_full"));
    assert.equal(header, "evidence_id,source,metric,unit,time,value,baseline,observed");
    // 24 + 18 + 18 points, and the question's empty metric.
    assert.equal(rows.length, 61);
    assert.equal(rows[0], "ev_metric_p95,investigation,http.server.duration p95,ms,2026-10-23T01:56:00.000Z,117,118,2950");
    assert.equal(rows[23], "ev_metric_p95,investigation,http.server.duration p95,ms,2026-10-23T02:19:00.000Z,2970,118,2950");
    assert.equal(rows[24], "ev_metric_rps,investigation,http.server.request.rate,req/s,2026-10-23T02:02:00.000Z,14,14,14.6");
    assert.equal(rows[60], "ev_q1_metric_1,q_1,db.client.connection.wait_time,ms,,,0,0");
  });

  it("writes JSON with null for the missing point", async () => {
    const file = await json(await get("evidence-metrics", "format=json&id=inc_export_full"));
    assert.equal(file.count, 61);
    assert.deepEqual(file.rows[60], {
      evidence_id: "ev_q1_metric_1",
      source: "q_1",
      metric: "db.client.connection.wait_time",
      unit: "ms",
      time: null,
      value: null,
      baseline: 0,
      observed: 0,
    });
  });
});

describe("GET /api/export/evidence-db", () => {
  it("writes one row per row returned, as JSON text in CSV", async () => {
    const [header, ...rows] = await csvLines(await get("evidence-db", "format=csv&id=inc_export_full"));
    assert.equal(header, "evidence_id,source,query,row_index,row");
    // 5 + 1 + 3 rows, and the question's query that returned none.
    assert.equal(rows.length, 10);
    assert.equal(
      rows[5],
      `ev_db_locks,investigation,SELECT count(*) AS blocked FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0,0,"{""blocked"":0}"`,
    );
    assert.equal(rows[9], "ev_q1_db_1,q_1,SELECT pid FROM pg_locks WHERE NOT granted,,");
  });

  it("writes the row as an object in JSON", async () => {
    const file = await json(await get("evidence-db", "format=json&id=inc_export_full"));
    assert.deepEqual(file.rows[8], {
      evidence_id: "ev_db_statements",
      source: "investigation",
      query: "SELECT left(query, 50) AS query, calls, round(mean_exec_time::numeric, 2) AS mean_ms FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 3",
      row_index: 2,
      row: { query: "SELECT 1", calls: 1810, mean_ms: 0.02 },
    });
    assert.deepEqual(file.rows[9], { evidence_id: "ev_q1_db_1", source: "q_1", query: "SELECT pid FROM pg_locks WHERE NOT granted", row_index: null, row: null });
  });
});

describe("GET /api/export/investigation-trace", () => {
  it("leads with the run, then thoughts and tool calls in time order", async () => {
    const file = await json(await get("investigation-trace", "format=json&id=inc_export_full"));
    assert.deepEqual(
      file.rows.map((r) => `${r.kind}:${r.id}`),
      ["run:null", "thought:th_1", "step:step_1", "thought:th_2", "step:step_2", "step:step_3", "step:step_4", "step:step_5", "step:step_6", "step:step_7", "step:step_8", "thought:th_3"],
    );
    assert.deepEqual(file.rows[0], {
      kind: "run",
      id: null,
      started_at: "2026-10-23T02:14:02.000Z",
      duration_ms: 60_000,
      tool: null,
      status: "completed",
      input: null,
      summary: null,
      evidence_ids: null,
      error: null,
      reasoning: null,
      reasoning_kind: null,
      text: null,
      source: "scenario:pool-leak",
      provider: "meta",
      model: "muse-spark-1.3",
      model_steps: 4,
      input_tokens: 18200,
      output_tokens: 940,
    });
  });

  it("keeps each step's call and each thought's reasoning, every key on every row", async () => {
    const res = await get("investigation-trace", "format=ndjson&id=inc_export_full");
    const rows = (await res.text()).trimEnd().split("\n").map((l) => JSON.parse(l));
    const keys = Object.keys(rows[0]);
    for (const row of rows) assert.deepEqual(Object.keys(row), keys);
    const step = rows.find((r) => r.id === "step_2");
    assert.deepEqual(
      { tool: step.tool, status: step.status, input: step.input, evidence_ids: step.evidence_ids, duration_ms: step.duration_ms, started_at: step.started_at },
      {
        tool: "query_logs",
        status: "completed",
        input: { service: "shopfront", level: "error", window: "30m", groupBy: "message" },
        evidence_ids: ["ev_log_timeout", "ev_log_stock_miss"],
        duration_ms: 588,
        started_at: "2026-10-23T02:14:04Z",
      },
    );
    const thought = rows.find((r) => r.id === "th_1");
    assert.deepEqual(
      { reasoning: thought.reasoning, reasoning_kind: thought.reasoning_kind, text: thought.text, tool: thought.tool },
      { reasoning: "Start with the alert's metric.", reasoning_kind: "summary", text: null, tool: null },
    );
  });

  it("leaves out the run row when nothing was recorded about it", () => {
    const incident = exampleIncidents.find((i) => i.id === "inc_pool_leak")!;
    assert.deepEqual(
      traceRows(incident).map((r) => r.kind),
      incident.steps.map(() => "step"),
    );
  });
});

describe("GET /api/export/fix-patch", () => {
  it("is the stored diff byte for byte", async () => {
    const res = await get("fix-patch", "format=patch&id=inc_export_full");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/x-diff; charset=utf-8");
    assert.match(filename(res) ?? "", new RegExp(`^fix-patch_p95-latency-and-500s-on-get-api-products_${STAMP}\\.patch$`));
    const bytes = new Uint8Array(await res.arrayBuffer());
    const stored = new TextEncoder().encode(full().fix!.patch);
    assert.deepEqual(bytes, stored);
    assert.equal(bytes.at(-1), 0x0a);
  });

  it("ends a diff stored without its last newline with one, as git apply needs", () => {
    const patch = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b";
    const meta = { subject: { kind: "incident", id: "inc_x", name: "x" }, exportedAt: new Date() };
    assert.equal(serialize(fixPatch, [{ patch }], "patch", meta).body, `${patch}\n`);
    assert.equal(serialize(fixPatch, [{ patch: "a\r\nb\r\n" }], "patch", meta).body, "a\r\nb\r\n");
  });
});

describe("GET /api/export/ask-answers", () => {
  it("writes every question in order as Markdown, its cited evidence listed with summaries", async () => {
    const res = await get("ask-answers", "format=md&id=inc_export_full");
    assert.equal(res.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.match(filename(res) ?? "", new RegExp(`^ask-answers_p95-latency-and-500s-on-get-api-products_${STAMP}\\.md$`));
    assert.equal(
      await res.text(),
      [
        '# Questions on "p95 latency and 500s on GET /api/products/:id"',
        "",
        "Incident `inc_export_full`. Answers cite evidence by ID in square brackets; each answer's cited evidence is listed under it.",
        "",
        "## 1. Why did the pool run out?",
        "",
        "Asked 2026-10-23T02:31:00.000Z · answered 2026-10-23T02:31:40.000Z · by muse-spark-1.3",
        "",
        "A missing stock row returns early without releasing the client [ev_log_timeout], so pool.connect waits [ev_q1_span_1]. See also [ev_gone].",
        "",
        "Cited evidence:",
        "",
        "- `ev_log_timeout`: 412x 'timeout exceeded when trying to connect' since 02:09",
        "- `ev_q1_span_1`: pool.connect waited 2990 ms",
        "- `ev_gone`: not in the incident's evidence",
        "",
        "## 2. Did the deploy at 01:58 change the pool size?",
        "",
        "Asked 2026-10-23T02:35:00.000Z · answered 2026-10-23T02:35:05.000Z · by muse-spark-1.3",
        "",
        "_Not answered: The model stopped responding_",
        "",
      ].join("\n"),
    );
  });

  it("writes them as JSON, with the cited evidence and the IDs that match none", async () => {
    const file = await json(await get("ask-answers", "format=json&id=inc_export_full"));
    assert.equal(file.count, 2);
    assert.deepEqual(file.rows[0], {
      question_id: "q_1",
      question: "Why did the pool\nrun out?",
      asked_at: "2026-10-23T02:31:00.000Z",
      answered_at: "2026-10-23T02:31:40.000Z",
      status: "answered",
      mode: "tools",
      provider: "meta",
      model: "muse-spark-1.3",
      answer: answered.answer,
      error: null,
      cited_evidence: [
        { evidence_id: "ev_log_timeout", summary: "412x 'timeout exceeded when trying to connect' since 02:09" },
        { evidence_id: "ev_q1_span_1", summary: "pool.connect waited 2990 ms" },
      ],
      unknown_evidence_ids: ["ev_gone"],
    });
    assert.deepEqual([file.rows[1].status, file.rows[1].error], ["failed", "The model stopped responding"]);
  });
});

describe("incident exports that aren't there", () => {
  const datasets = ["incident", "evidence-logs", "evidence-spans", "evidence-metrics", "evidence-db", "investigation-trace", "fix-patch", "ask-answers"];
  const formatOf = (d: string) => (d === "fix-patch" ? "patch" : "json");

  it("answers 404 for an unknown incident", async () => {
    for (const d of datasets) assert.equal((await get(d, `format=${formatOf(d)}&id=inc_nope`)).status, 404, d);
  });

  it("answers 404 when the incident has nothing of that kind, and serves its record", async () => {
    for (const d of datasets.slice(1)) assert.equal((await get(d, `format=${formatOf(d)}&id=inc_export_bare`)).status, 404, d);
    assert.equal((await get("incident", "format=json&id=inc_export_bare")).status, 200);
  });

  it("answers 400 for an id that isn't an incident's, or a format the dataset hasn't", async () => {
    for (const d of datasets) {
      for (const query of [`format=${formatOf(d)}`, `format=${formatOf(d)}&id=../settings`]) {
        const res = await get(d, query);
        assert.equal(res.status, 400, `${d} ${query}`);
        assert.match((await res.json()).error, /id/);
      }
    }
    assert.equal((await get("evidence-spans", "format=ndjson&id=inc_export_full")).status, 400);
    assert.equal((await get("fix-patch", "format=json&id=inc_export_full")).status, 400);
  });
});
