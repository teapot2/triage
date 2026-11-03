import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Evidence, Hypothesis, InvestigationReport } from "../schema";
import { proposeMitigation, whyNoMitigation } from "./propose";

const now = "2026-10-23T02:15:00.000Z";

type Commit = Extract<Evidence, { kind: "commit" }>;

const deploy = (id: string, sha: string, message: string, more: Partial<Commit> = {}): Evidence => ({
  id,
  kind: "commit",
  tool: "deploy_history",
  summary: message,
  observedAt: "2026-10-23T02:00:00.000Z",
  sha,
  author: "unknown",
  message,
  files: [],
  ...more,
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

  it("rolls back a release, carrying its branch for the fix PR", () => {
    const release = deploy("ev_commit_4", "9f3c2a1", "feat(shopfront): return a formatted price from the product API", {
      deployKind: "deploy",
      branch: "shopfront-release/formatted-price",
    });
    const m = propose([latency, release]);
    assert.equal(m?.kind, "rollback");
    assert.equal(m?.target, "9f3c2a1");
    assert.equal(m?.branch, "shopfront-release/formatted-price");
    assert.deepEqual(m?.steps, ["Roll back 9f3c2a1 on shopfront"]);
    assert.deepEqual(m?.why.evidenceIds, ["ev_commit_4"]);
    // A deploy record with no branch leaves the field off.
    assert.equal(propose([latency, codeDeploy])?.branch, undefined);
  });

  it("never proposes rolling back a rollback", () => {
    const rolledBack = deploy("ev_commit_5", "9f3c2a1", "deploy: rolled back 9f3c2a1", { deployKind: "rollback" });
    assert.equal(propose([latency, rolledBack]), undefined);
    // Nor when it sits beside the deploy it undid: the deploy is the target.
    const release = deploy("ev_commit_4", "9f3c2a1", "feat: formatted price", { deployKind: "deploy", observedAt: "2026-10-23T01:50:00.000Z" });
    const m = propose([latency, rolledBack, release]);
    assert.equal(m?.kind, "rollback");
    assert.deepEqual(m?.why.evidenceIds, ["ev_commit_4"]);
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

  describe("with the flags' states from the logs", () => {
    const cited = (evidence: Evidence[], flags?: Record<string, boolean>) =>
      proposeMitigation(report(evidence.map((e) => e.id)), evidence, "shopfront", now, undefined, flags);

    it("never turns off a flag the blamed code checks when the logs say it is off", () => {
      assert.equal(cited([latency, source], { FF_STOCK_DIRECT_QUERY: false }), undefined);
      // With a deploy to roll back, that is the next rule.
      const m = cited([latency, source, codeDeploy], { FF_STOCK_DIRECT_QUERY: false });
      assert.equal(m?.kind, "rollback");
      assert.equal(m?.target, "a1b9c4e");
    });

    it("turns it off as before when the logs say it is on or say nothing", () => {
      assert.equal(cited([latency, source], undefined)?.kind, "flag_off");
      assert.equal(cited([latency, source], {})?.kind, "flag_off");
      assert.equal(cited([latency, source], { FF_STOCK_DIRECT_QUERY: true })?.kind, "flag_off");
      assert.equal(cited([latency, source], { FF_LIST_PRICES: false })?.target, "FF_STOCK_DIRECT_QUERY");
    });

    it("skips a flag turned on in the evidence that the logs say is off again", () => {
      assert.equal(cited([latency, flagOn], { FF_STOCK_DIRECT_QUERY: false }), undefined);
      assert.equal(cited([latency, flagOn, codeDeploy], { FF_STOCK_DIRECT_QUERY: false })?.kind, "rollback");
      // Another flag turned on, still on, is the candidate instead.
      const other = deploy("ev_commit_3", "config:FF_NEW_CHECKOUT", "ops: FF_NEW_CHECKOUT turned on");
      assert.equal(cited([latency, flagOn, other], { FF_STOCK_DIRECT_QUERY: false })?.target, "FF_NEW_CHECKOUT");
    });

    it("skips a flag turned on after the blamed deploy that is off again", () => {
      const later = { ...flagOn, observedAt: "2026-10-23T02:05:00.000Z" };
      const evidence = [latency, codeDeploy, later];
      const m = proposeMitigation(report([latency.id, codeDeploy.id]), evidence, "shopfront", now, undefined, {
        FF_STOCK_DIRECT_QUERY: false,
      });
      assert.equal(m?.kind, "rollback");
    });
  });

  describe("whyNoMitigation", () => {
    const why = (evidence: Evidence[], flags?: Record<string, boolean>) =>
      whyNoMitigation(report(evidence.map((e) => e.id)), evidence, flags);

    it("says the cited flag is already off", () => {
      assert.equal(why([latency, source], { FF_STOCK_DIRECT_QUERY: false }), "Nothing to undo: FF_STOCK_DIRECT_QUERY is already off.");
      assert.equal(why([latency, flagOn], { FF_STOCK_DIRECT_QUERY: false }), "Nothing to undo: FF_STOCK_DIRECT_QUERY is already off.");
    });

    it("says the cited deploy was already rolled back", () => {
      const rollback = deploy("ev_commit_5", "a1b9c4e", "deploy: rolled back a1b9c4e", { deployKind: "rollback" });
      assert.equal(why([latency, rollback]), "Nothing to undo: a1b9c4e was already rolled back.");
    });

    it("points at the load when the diagnosis cites no change", () => {
      assert.match(why([latency]), /cites no flag flip or deploy.*scale out or wait/);
    });
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
