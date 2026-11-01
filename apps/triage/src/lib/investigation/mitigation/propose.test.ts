import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Evidence, Hypothesis, InvestigationReport } from "../schema";
import { proposeMitigation } from "./propose";

const now = "2026-10-23T02:15:00.000Z";

const deploy = (id: string, sha: string, message: string): Evidence => ({
  id,
  kind: "commit",
  tool: "deploy_history",
  summary: message,
  observedAt: "2026-10-23T02:00:00.000Z",
  sha,
  author: "unknown",
  message,
  files: [],
});

const flagOn = deploy("ev_commit_1", "config:FF_STOCK_DIRECT_QUERY", "ops: FF_STOCK_DIRECT_QUERY turned on");
const flagOff = deploy("ev_commit_1", "config:FF_STOCK_DIRECT_QUERY", "ops: FF_STOCK_DIRECT_QUERY turned off");
const codeDeploy = deploy("ev_commit_2", "a1b9c4e", "feat: show stock level on product page");

const source: Evidence = {
  id: "ev_source_1",
  kind: "source",
  tool: "read_source",
  summary: "getStockLevel",
  file: "src/lib/stock.ts",
  startLine: 1,
  code: 'export const getStockLevel = (id: number) =>\n  isEnabled("FF_STOCK_DIRECT_QUERY") ? getStockLevelDirect(id) : getStockLevelPooled(id);',
};

const pool: Evidence = {
  id: "ev_metric_1",
  kind: "metric",
  tool: "query_metrics",
  summary: "Pool pinned at 10",
  metric: "db.client.connection.count{state=used}",
  unit: "connections",
  baseline: 2,
  observed: 10,
  series: [],
};

const latency: Evidence = { ...pool, id: "ev_metric_2", metric: "http.server.request.duration.p95", unit: "ms" };

// A root_cause report whose leading hypothesis' chain cites `ids`.
function report(ids: string[]): InvestigationReport {
  const claim = (text: string) => ({ text, evidenceIds: ids });
  const leading: Hypothesis = {
    id: "h1",
    title: "Connection leak",
    confidence: 0.8,
    status: "leading",
    causalChain: { symptom: claim("p95 up"), propagation: claim("pool full"), rootCause: claim("leak") },
  };
  return { hypotheses: [leading], verdict: { kind: "root_cause", hypothesisId: "h1" }, servicesQueried: ["shopfront"] };
}

const propose = (evidence: Evidence[]) =>
  proposeMitigation(report(evidence.map((e) => e.id)), evidence, "shopfront", now);

describe("proposeMitigation", () => {
  it("turns off a flag the deploy history shows turned on, citing that record", () => {
    const m = propose([latency, flagOn, codeDeploy]);
    assert.equal(m?.kind, "flag_off");
    assert.equal(m?.target, "FF_STOCK_DIRECT_QUERY");
    assert.equal(m?.title, "Turn off FF_STOCK_DIRECT_QUERY");
    assert.deepEqual(m?.why.evidenceIds, ["ev_commit_1"]);
    assert.equal(m?.state, "proposed");
    assert.equal(m?.proposedAt, now);
  });

  it("turns off a flag the blamed code checks", () => {
    const m = propose([latency, source]);
    assert.equal(m?.kind, "flag_off");
    assert.equal(m?.target, "FF_STOCK_DIRECT_QUERY");
    assert.deepEqual(m?.why.evidenceIds, ["ev_source_1"]);
  });

  it("rolls back a deploy when no flag is involved", () => {
    const m = propose([latency, codeDeploy]);
    assert.equal(m?.kind, "rollback");
    assert.equal(m?.target, "a1b9c4e");
    assert.equal(m?.title, "Roll back shopfront to the deploy before a1b9c4e");
    assert.equal(m?.undo, "Redeploy a1b9c4e");
    assert.equal(m?.risk, "low");
  });

  it("prefers a flag turned on after the blamed deploy, even when the chain cites only the deploy", () => {
    const later = { ...flagOn, observedAt: "2026-10-23T02:05:00.000Z" };
    const evidence = [latency, codeDeploy, later];
    const m = proposeMitigation(report([latency.id, codeDeploy.id]), evidence, "shopfront", now);
    assert.equal(m?.kind, "flag_off");
    assert.equal(m?.target, "FF_STOCK_DIRECT_QUERY");
    assert.deepEqual(m?.why.evidenceIds, [later.id]);
  });

  it("still rolls back when the flag was turned on before the blamed deploy", () => {
    const earlier = { ...flagOn, observedAt: "2026-10-23T01:00:00.000Z" };
    const m = proposeMitigation(report([latency.id, codeDeploy.id]), [latency, codeDeploy, earlier], "shopfront", now);
    assert.equal(m?.kind, "rollback");
  });

  it("ignores a flag turned on after the alert, which can't have caused it", () => {
    const afterAlert = { ...flagOn, observedAt: "2026-10-23T02:12:00.000Z" };
    const evidence = [latency, codeDeploy, afterAlert];
    const m = proposeMitigation(report([latency.id, codeDeploy.id]), evidence, "shopfront", now, "2026-10-23T02:10:00.000Z");
    assert.equal(m?.kind, "rollback");
    // Without an alert time there's no bound, as before.
    assert.equal(proposeMitigation(report([latency.id, codeDeploy.id]), evidence, "shopfront", now)?.kind, "flag_off");
  });

  it("of several flags turned on after the deploy, picks the first", () => {
    const second = deploy("ev_commit_3", "config:FF_NEW_CHECKOUT", "ops: FF_NEW_CHECKOUT turned on");
    const evidence = [
      latency,
      codeDeploy,
      { ...second, observedAt: "2026-10-23T02:08:00.000Z" },
      { ...flagOn, observedAt: "2026-10-23T02:03:00.000Z" },
    ];
    const m = proposeMitigation(report([latency.id, codeDeploy.id]), evidence, "shopfront", now, "2026-10-23T02:10:00.000Z");
    assert.equal(m?.kind, "flag_off");
    assert.equal(m?.target, "FF_STOCK_DIRECT_QUERY");
  });

  it("proposes nothing for a healthy verdict", () => {
    const r: InvestigationReport = {
      hypotheses: [],
      verdict: { kind: "healthy", rationale: { text: "All normal", evidenceIds: [flagOn.id] } },
      servicesQueried: ["shopfront"],
    };
    assert.equal(proposeMitigation(r, [flagOn], "shopfront", now), undefined);
  });

  it("proposes nothing for a flag that was turned off", () => {
    assert.equal(propose([latency, flagOff]), undefined);
  });

  it("recycles held connections only when pool evidence is cited", () => {
    const without = propose([latency, flagOn]);
    assert.deepEqual(without?.steps, ["Turn off FF_STOCK_DIRECT_QUERY on shopfront"]);

    const withPool = propose([latency, flagOn, pool]);
    assert.equal(withPool?.steps.length, 2);
    assert.match(withPool?.steps[1] ?? "", /^Recycle pooled connections/);
    assert.deepEqual(withPool?.why.evidenceIds, ["ev_commit_1", "ev_metric_1"]);
  });

  it("doesn't recycle for database diagnostics or a pool at its usual level", () => {
    const activity: Evidence = {
      id: "ev_db_1",
      kind: "db",
      tool: "db_diagnostics",
      summary: "2 connections, both idle",
      query: "SELECT pid, state FROM pg_stat_activity",
      rows: [
        { pid: 61204, state: "idle" },
        { pid: 61211, state: "idle" },
      ],
    };
    const normalPool: Evidence = { ...pool, id: "ev_metric_3", summary: "Pool at 1 of 10", baseline: 1, observed: 2 };
    const m = propose([latency, flagOn, activity, normalPool]);
    assert.deepEqual(m?.steps, ["Turn off FF_STOCK_DIRECT_QUERY on shopfront"]);
    assert.deepEqual(m?.why.evidenceIds, ["ev_commit_1"]);
    assert.doesNotMatch(m?.why.text ?? "", /pool|leak|connection/i);
  });
});
