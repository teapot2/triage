import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { uptimeNote } from "../context";
import { shopfrontDir } from "../live/live-source";
import { QuestionRecorder } from "../recorder";
import type { Question } from "../schema";
import type { TelemetrySource } from "../source";
import { createInvestigationTools } from "../tools";
import { failingRun } from "./incident";
import { defaultCheck, type UptimeSample } from "./model";
import { createUptimeSource } from "./source";

const google = defaultCheck({ id: "chk_abc123", name: "Google", url: "https://www.google.com/" });
const now = Date.parse("2026-10-30T10:10:00.000Z");

// Every 30 s from 10:00: ten ok, two slow, then down from 10:06 with one ok
// at 10:06:30 (five timeouts, two 503s), and one after the alert.
const at = (minute: number, second = 0) => `2026-10-30T10:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;
const ok = (m: number, s = 0): UptimeSample => ({ at: at(m, s), ms: 180, status: 200, outcome: "ok" });
const timeout = (m: number, s = 0): UptimeSample => ({ at: at(m, s), ms: 15_000, outcome: "down", error: "timeout after 15000 ms" });
const unavailable = (m: number, s = 0): UptimeSample => ({ at: at(m, s), ms: 40, status: 503, outcome: "down", error: "HTTP 503" });
const samples: UptimeSample[] = [
  ...[0, 1, 2, 3, 4].flatMap((m) => [ok(m), ok(m, 30)]),
  { at: at(5), ms: 12_000, status: 200, outcome: "slow" },
  { at: at(5, 30), ms: 12_500, status: 200, outcome: "slow" },
  timeout(6),
  ok(6, 30),
  timeout(7),
  unavailable(7, 30),
  timeout(8),
  unavailable(8, 30),
  timeout(9),
  timeout(9, 30),
  ok(10, 30),
];

const uptime = () => createUptimeSource(google, samples, { now });

describe("createUptimeSource", () => {
  it("describes one service, the host, with no dependencies, and the two series", async () => {
    const { source, appDir, service } = await uptime();
    const d = source.describe();
    assert.equal(d.id, "uptime:chk_abc123");
    assert.equal(d.now, "2026-10-30T10:10:00.000Z");
    assert.deepEqual(d.services, [{ name: "www.google.com", dependsOn: [] }]);
    assert.deepEqual(
      d.metrics.map((m) => [m.name, m.service, m.unit]),
      [
        ["uptime.response_time{check=chk_abc123}", "www.google.com", "ms"],
        ["uptime.availability{check=chk_abc123}", "www.google.com", "%"],
      ],
    );
    assert.deepEqual(d.external, { url: "https://www.google.com/" });
    assert.equal(service, "www.google.com");
    assert.equal(appDir, undefined);
  });

  it("charts each check's response time, failures at the timeout, up to the alert", async () => {
    const { source } = await uptime();
    const series = await source.queryMetric({ name: "uptime.response_time{check=chk_abc123}", windowMinutes: 30 });
    assert.equal(series?.unit, "ms");
    assert.equal(series?.points.length, 20);
    assert.deepEqual(series?.points[0], { t: at(0), value: 180 });
    assert.deepEqual(series?.points[10], { t: at(5), value: 12_000 });
    // The 503 answered in 40 ms, but it failed.
    assert.deepEqual(series?.points[15], { t: at(7, 30), value: 15_000 });
    assert.equal(series?.points.at(-1)?.t, at(9, 30));

    const recent = await source.queryMetric({ name: "uptime.response_time{check=chk_abc123}", windowMinutes: 3 });
    assert.deepEqual(recent?.points.map((p) => p.t), [at(7, 30), at(8), at(8, 30), at(9), at(9, 30)]);
  });

  it("charts availability per minute as the share of checks that were ok", async () => {
    const { source } = await uptime();
    const series = await source.queryMetric({ name: "uptime.availability{check=chk_abc123}", windowMinutes: 30 });
    assert.equal(series?.unit, "%");
    assert.deepEqual(
      series?.points.map((p) => [p.t.slice(11, 16), p.value]),
      [
        ["10:00", 100],
        ["10:01", 100],
        ["10:02", 100],
        ["10:03", 100],
        ["10:04", 100],
        ["10:05", 0],
        ["10:06", 50],
        ["10:07", 0],
        ["10:08", 0],
        ["10:09", 0],
      ],
    );
    assert.equal(await source.queryMetric({ name: "http.server.request.rate", windowMinutes: 30 }), undefined);
  });

  it("groups the failed checks by error as error logs, most frequent first", async () => {
    const { source } = await uptime();
    const groups = await source.queryLogs({ windowMinutes: 30 });
    assert.deepEqual(
      groups.map((g) => [g.message, g.level, g.count, g.firstSeen, g.lastSeen, g.service]),
      [
        ["timeout after 15000 ms", "error", 5, at(6), at(9, 30), "www.google.com"],
        ["HTTP 503", "error", 2, at(7, 30), at(8, 30), "www.google.com"],
      ],
    );
    // The group leads to the last check that failed that way.
    const spans = await source.queryTraces({ status: "error", limit: 10 });
    assert.ok(spans.some((s) => s.traceId === groups[1].traceId && s.startedAt === at(8, 30)));

    assert.deepEqual(
      (await source.queryLogs({ windowMinutes: 2 })).map((g) => [g.message, g.count]),
      [
        ["timeout after 15000 ms", 2],
        ["HTTP 503", 1],
      ],
    );
    assert.deepEqual((await source.queryLogs({ contains: "503", windowMinutes: 30 })).map((g) => g.message), ["HTTP 503"]);
    assert.deepEqual(await source.queryLogs({ service: "shopfront", windowMinutes: 30 }), []);
    assert.equal((await source.queryLogs({ minLevel: "error", windowMinutes: 30 })).length, 2);
  });

  it("returns one span per check, slowest first, honouring the filters and the limit", async () => {
    const { source } = await uptime();
    const slowest = await source.queryTraces({ limit: 3 });
    assert.deepEqual(
      slowest.map((s) => [s.startedAt, s.durationMs, s.status]),
      [
        [at(9, 30), 15_000, "error"],
        [at(9), 15_000, "error"],
        [at(8), 15_000, "error"],
      ],
    );
    assert.equal(slowest[0].name, "GET https://www.google.com/");
    assert.equal(slowest[0].route, "/");
    assert.equal(slowest[0].service, "www.google.com");
    assert.deepEqual(slowest[0].attributes, {
      "url.full": "https://www.google.com/",
      "uptime.outcome": "down",
      "error.message": "timeout after 15000 ms",
    });

    const failed = await source.queryTraces({ status: "error", limit: 10 });
    assert.equal(failed.length, 7);
    const unavailableSpan = failed.find((s) => s.startedAt === at(7, 30))!;
    assert.deepEqual(unavailableSpan.attributes, {
      "url.full": "https://www.google.com/",
      "uptime.outcome": "down",
      "http.response.status_code": 503,
      "error.message": "HTTP 503",
    });
    assert.equal(unavailableSpan.durationMs, 40);

    const slow = await source.queryTraces({ status: "ok", minDurationMs: 10_000, limit: 10 });
    assert.deepEqual(slow.map((s) => [s.startedAt, s.attributes["uptime.outcome"], s.attributes["http.response.status_code"]]), [
      [at(5, 30), "slow", 200],
      [at(5), "slow", 200],
    ]);
    // Never past the alert: the 10:10:30 check isn't there.
    assert.equal((await source.queryTraces({ route: "/", limit: 10 })).length, 10);
    assert.equal((await source.queryTraces({ status: "ok", limit: 10 })).length, 10);
    assert.deepEqual(await source.queryTraces({ route: "/api/health", limit: 10 }), []);
    assert.deepEqual(await source.queryTraces({ service: "postgres", limit: 10 }), []);
    // A window leaves out the slow checks before it, however slow.
    assert.deepEqual(await source.queryTraces({ status: "ok", minDurationMs: 10_000, windowMinutes: 4, limit: 10 }), []);
    // After 10:06, so the 10:06:00 timeout is out too.
    assert.equal((await source.queryTraces({ status: "error", windowMinutes: 4, limit: 10 })).length, 6);
  });

  it("has no database, source, git or deploys, and the tools say why in a line", async () => {
    const { source } = await uptime();
    assert.deepEqual(await source.dbDiagnostics("activity"), { query: "", rows: [] });
    assert.equal(await source.readSource("src/app.ts"), undefined);
    assert.deepEqual(await source.listSourceFiles(), []);
    assert.deepEqual(await source.gitLog({ limit: 10 }), []);
    assert.deepEqual(await source.deployHistory({ sinceMinutes: 60 }), []);

    const recorder = new QuestionRecorder(question, "inc_test", "www.google.com", async () => {});
    const tools = createInvestigationTools(source, recorder, { submit: false });
    const call = { toolCallId: "call_1", messages: [] } as never;
    const runs = [
      await tools.db_diagnostics.execute!({ check: "activity" }, call),
      await tools.read_source.execute!({ path: "src/app.ts" }, call),
      await tools.git_log.execute!({}, call),
      await tools.deploy_history.execute!({}, call),
    ] as { summary: string; evidence: unknown[] }[];
    assert.deepEqual(
      runs.map((r) => r.summary),
      ["database", "source code", "git history", "deploy history"].map(
        (what) => `No ${what} connected: https://www.google.com/ is an external endpoint, known only from Triage's own checks`,
      ),
    );
    assert.ok(runs.every((r) => r.evidence.length === 0));
  });
});

const question: Question = {
  id: "q_1",
  text: "Why?",
  askedAt: "2026-10-30T10:11:00.000Z",
  status: "answering",
  answer: "",
  citedIds: [],
  unknownIds: [],
  steps: [],
  evidence: [],
  mode: "tools",
  model: "test",
};

// Shopfront's live source, stubbed: one series, one log group, two spans.
function stubLive(seen: { now?: number }): (opts: { now: number }) => Promise<TelemetrySource> {
  return async ({ now }) => {
    seen.now = now;
    return {
      describe: () => ({
        id: "live:shopfront",
        now: new Date(now).toISOString(),
        services: [
          { name: "shopfront", dependsOn: ["postgres"] },
          { name: "postgres", dependsOn: [] },
        ],
        metrics: [{ name: "http.server.request.rate", service: "shopfront", unit: "req/s", description: "rate" }],
      }),
      queryLogs: async () => [
        { service: "shopfront", level: "error", message: "Error: timeout exceeded when trying to connect", count: 3, firstSeen: at(6), lastSeen: at(9) },
      ],
      queryTraces: async () => [
        { traceId: "t1", service: "shopfront", name: "GET /api/products/[id]", route: "/api/products/[id]", startedAt: at(8), durationMs: 20_000, status: "error", attributes: {} },
        { traceId: "t2", service: "postgres", name: "SELECT 1", startedAt: at(8), durationMs: 2, status: "ok", attributes: {} },
      ],
      queryMetric: async ({ name }) =>
        name === "http.server.request.rate"
          ? { name, service: "shopfront", unit: "req/s", description: "rate", points: [{ t: at(9), value: 4 }] }
          : undefined,
      dbDiagnostics: async () => ({ query: "SELECT 1", rows: [{ n: 1 }] }),
      readSource: async (path) => ({ path, content: "x" }),
      listSourceFiles: async () => ["src/db/client.ts"],
      gitLog: async () => [],
      deployHistory: async () => [],
    };
  };
}

describe("createUptimeSource on Shopfront", () => {
  const health = defaultCheck({ id: "chk_shop01", name: "Shopfront", url: "http://localhost:3001/api/health" });

  it("joins the live source for a check on Shopfront's origin, and passes its code", async () => {
    const seen: { now?: number } = {};
    const { source, appDir, service } = await createUptimeSource(health, samples, { now, live: stubLive(seen) });
    assert.equal(seen.now, now);
    assert.equal(appDir, shopfrontDir);
    assert.equal(service, "shopfront");

    const d = source.describe();
    assert.equal(d.id, "uptime:chk_shop01");
    assert.equal(d.external, undefined);
    assert.deepEqual(d.services.map((s) => s.name), ["shopfront", "postgres"]);
    assert.deepEqual(d.metrics.map((m) => m.name), [
      "http.server.request.rate",
      "uptime.response_time{check=chk_shop01}",
      "uptime.availability{check=chk_shop01}",
    ]);

    const availability = await source.queryMetric({ name: "uptime.availability{check=chk_shop01}", windowMinutes: 30 });
    assert.equal(availability?.service, "shopfront");
    assert.equal((await source.queryMetric({ name: "http.server.request.rate", windowMinutes: 30 }))?.points[0].value, 4);

    const logs = await source.queryLogs({ windowMinutes: 30 });
    assert.deepEqual(logs.map((g) => [g.message, g.count]), [
      ["timeout after 15000 ms", 5],
      ["Error: timeout exceeded when trying to connect", 3],
      ["HTTP 503", 2],
    ]);
    assert.ok(logs.every((g) => g.service === "shopfront"));

    const spans = await source.queryTraces({ limit: 3 });
    assert.deepEqual(spans.map((s) => s.traceId.startsWith("chk_") ? s.startedAt : s.traceId), ["t1", at(9, 30), at(9)]);
    assert.equal(spans[1].name, "GET http://localhost:3001/api/health");
    assert.equal(spans[1].route, "/api/health");

    assert.deepEqual(await source.dbDiagnostics("activity"), { query: "SELECT 1", rows: [{ n: 1 }] });
    assert.deepEqual(await source.listSourceFiles(), ["src/db/client.ts"]);
  });

  it("leaves every other origin to the check results alone", async () => {
    const seen: { now?: number } = {};
    const other = defaultCheck({ id: "chk_shop02", name: "Other", url: "http://localhost:3002/api/health" });
    const { source, appDir } = await createUptimeSource(other, samples, { now, live: stubLive(seen) });
    assert.equal(seen.now, undefined);
    assert.equal(appDir, undefined);
    assert.deepEqual(source.describe().services, [{ name: "localhost:3002", dependsOn: [] }]);
  });
});

describe("uptimeNote", () => {
  it("tells the investigation what the check results are, and when inconclusive is right", async () => {
    const alone = uptimeNote((await uptime()).source);
    assert.match(alone, /Triage's own external HTTP check/);
    assert.match(alone, /inconclusive verdict naming what is missing \(application logs, traces, a deploy history\)/);
    assert.match(alone, /when it started, how it failed \(timeouts, which statuses\), and whether it is intermittent/);

    const health = defaultCheck({ id: "chk_shop01", name: "Shopfront", url: "http://localhost:3001/api/health" });
    const joined = uptimeNote((await createUptimeSource(health, samples, { now, live: stubLive({}) })).source);
    assert.match(joined, /application's own telemetry is listed too/);
    assert.doesNotMatch(joined, /inconclusive/);

    const live = await stubLive({})({ now });
    assert.equal(uptimeNote(live), "");
  });
});

describe("failingRun", () => {
  it("is the newest checks that failed the way the rule counts", () => {
    assert.deepEqual(failingRun("down", samples.slice(0, -1)).map((s) => s.at), [at(7), at(7, 30), at(8), at(8, 30), at(9), at(9, 30)]);
    assert.deepEqual(failingRun("slow", samples.slice(0, 12)).map((s) => s.at), [at(5), at(5, 30)]);
    assert.deepEqual(failingRun("down", samples), []);
  });
});
