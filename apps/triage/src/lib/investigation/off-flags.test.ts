import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { flagContext, GRACE_MS, offFlagProblems } from "./off-flags";
import type { Evidence, Hypothesis, InvestigationReport } from "./schema";
import type { DeployRecord, TelemetrySource } from "./source";

// The shapes of inc_mw1i8ois_1bec79 (2026-11-04): a Page latency alert at
// 02:35:49 blamed on FF_STOCK_DIRECT_QUERY, turned on at 02:00 and off
// again at 02:03.
const alertAt = "2026-11-04T02:35:49.000Z";

type Commit = Extract<Evidence, { kind: "commit" }>;

const record = (id: string, sha: string, message: string, observedAt: string, more: Partial<Commit> = {}): Commit => ({
  id,
  kind: "commit",
  tool: "deploy_history",
  summary: message,
  observedAt,
  sha,
  author: "unknown",
  message,
  files: [],
  deployKind: sha.startsWith("config:") ? "config" : "deploy",
  ...more,
});

const turnedOn = record("ev_commit_3", "config:FF_STOCK_DIRECT_QUERY", "ops: FF_STOCK_DIRECT_QUERY turned on", "2026-11-04T02:00:59.265Z");
const turnedOff = record("ev_commit_2", "config:FF_STOCK_DIRECT_QUERY", "ops: FF_STOCK_DIRECT_QUERY turned off", "2026-11-04T02:03:04.620Z");
const codeDeploy = record("ev_commit_4", "0dfdbac", "feat(shopfront): return a formatted price from the product API", "2026-11-04T02:30:00.000Z");

const stockSource: Evidence = {
  id: "ev_source_3",
  kind: "source",
  tool: "read_source",
  summary: "src/lib/stock.ts lines 1-52",
  file: "src/lib/stock.ts",
  startLine: 1,
  code: 'return isEnabled("FF_STOCK_DIRECT_QUERY") ? getStockLevelDirect(productId) : getStockLevelOrm(productId);',
};
const missingRows: Evidence = {
  id: "ev_log_10",
  kind: "log",
  tool: "query_logs",
  summary: "61x info 'stock row missing, returning default'",
  observedAt: "2026-11-04T02:35:41.691Z",
  service: "shopfront",
  level: "info",
  message: "stock row missing, returning default",
  count: 61,
};
const latency: Evidence = {
  id: "ev_metric_1",
  kind: "metric",
  tool: "query_metrics",
  summary: "p95 2059 ms",
  metric: "http.server.request.duration.p95{route=/products/[id]}",
  unit: "ms",
  baseline: 1349,
  observed: 2059,
  series: [],
};
const evidence: Evidence[] = [turnedOn, turnedOff, codeDeploy, stockSource, missingRows, latency];

const claim = (text: string, ...evidenceIds: string[]) => ({ text, evidenceIds });

function report(leading: { title: string; rootCause: string; cites: string[] }, verdict: InvestigationReport["verdict"] = { kind: "root_cause", hypothesisId: "h1" }): InvestigationReport {
  const other = (id: string, title: string): Hypothesis => ({
    id,
    title,
    confidence: 0.1,
    status: "rejected",
    causalChain: {
      symptom: claim("Product pages slow", "ev_metric_1"),
      propagation: claim("Requests queue for the database", "ev_metric_1"),
      rootCause: claim("Database overloaded by queries", "ev_metric_1"),
    },
    rejectedBecause: claim("Query times stayed flat", "ev_metric_1"),
  });
  return {
    summary: "Product pages slowed down.",
    hypotheses: [
      {
        id: "h1",
        title: leading.title,
        confidence: 0.55,
        status: verdict.kind === "root_cause" ? "leading" : "plausible",
        causalChain: {
          symptom: claim("GET products p95 2059ms at 02:35", "ev_metric_1"),
          propagation: claim("Requests wait for pooled connections", "ev_metric_1"),
          rootCause: claim(leading.rootCause, ...leading.cites),
        },
      },
      other("h2", "DB overload"),
      other("h3", "Traffic spike"),
    ],
    verdict,
    servicesQueried: ["postgres", "shopfront"],
  };
}

// The report as it was filed that night.
const tonight = report({
  title: "Pool leak in direct stock query",
  rootCause: "src/lib/stock.ts getStockLevelDirect returns without release on missing row, 61 such rows, flag on at 02:00",
  cites: ["ev_source_3", "ev_commit_3", "ev_commit_2", "ev_log_10"],
});

const flagsOff = { FF_STOCK_DIRECT_QUERY: false, FF_LIST_PRICES: false, FF_LIVE_RATINGS: false };

describe("offFlagProblems", () => {
  it("rejects a root cause resting on a flag turned off before the alert", () => {
    const problems = offFlagProblems(tonight, evidence, { flags: flagsOff, alertAt });
    assert.equal(problems.length, 1);
    const [p] = problems;
    assert.match(p, /depends on FF_STOCK_DIRECT_QUERY/);
    assert.match(p, /cites ev_commit_3, where FF_STOCK_DIRECT_QUERY was turned on/);
    assert.match(p, /turned off at 02:03 \(ev_commit_2\), before the alert at 02:35/);
    assert.match(p, /isn't running now\. Rule it out, or name what is causing this now/);
  });

  it("says the flag was off at the alert when no record shows it turned off", () => {
    const [p] = offFlagProblems(tonight, [turnedOn, stockSource, missingRows, latency], { flags: flagsOff, alertAt });
    assert.match(p, /it was off at the alert \(02:35\)/);
  });

  it("ignores a turned-off record from after the alert", () => {
    const later = { ...turnedOff, observedAt: "2026-11-04T02:40:00.000Z" };
    const [p] = offFlagProblems(tonight, [turnedOn, later, stockSource, missingRows, latency], { flags: flagsOff, alertAt });
    assert.match(p, /it was off at the alert/);
  });

  it("accepts the same report when the flag is on at the alert", () => {
    assert.deepEqual(offFlagProblems(tonight, evidence, { flags: { ...flagsOff, FF_STOCK_DIRECT_QUERY: true }, alertAt }), []);
  });

  it("accepts it when the flag's state is unknown", () => {
    assert.deepEqual(offFlagProblems(tonight, evidence, { flags: undefined, alertAt }), []);
    assert.deepEqual(offFlagProblems(tonight, evidence, { flags: {}, alertAt }), []);
    assert.deepEqual(offFlagProblems(tonight, evidence, { flags: { FF_LIST_PRICES: false }, alertAt }), []);
  });

  it("accepts a root cause that names no flag and cites no flag flip", () => {
    const load = report({
      title: "Request rate tripled",
      rootCause: "Traffic rose from 2 to 6 requests per second and every page slowed with it",
      cites: ["ev_metric_1"],
    });
    assert.deepEqual(offFlagProblems(load, evidence, { flags: flagsOff, alertAt }), []);
  });

  it("rejects a root cause that names an off flag without citing its flip", () => {
    const named = report({
      title: "FF_STOCK_DIRECT_QUERY path holds connections",
      rootCause: "getStockLevelDirect returns early without releasing its client",
      cites: ["ev_source_3"],
    });
    const [p] = offFlagProblems(named, evidence, { flags: flagsOff, alertAt });
    assert.match(p, /depends on FF_STOCK_DIRECT_QUERY \(it names FF_STOCK_DIRECT_QUERY\)/);
  });

  it("accepts a claim that says the flag is off or ruled out", () => {
    for (const rootCause of [
      "Dev-server cold renders on every page; FF_STOCK_DIRECT_QUERY was turned off at 02:03",
      "Cold renders, with FF_STOCK_DIRECT_QUERY disabled",
      "Cold renders; the direct stock query is ruled out",
    ]) {
      assert.deepEqual(offFlagProblems(report({ title: "Cold renders", rootCause, cites: ["ev_metric_1", "ev_commit_2"] }), evidence, { flags: flagsOff, alertAt }), [], rootCause);
    }
  });

  it("accepts what a flag left behind once the claim says it's off", () => {
    const leftover = report({
      title: "Connections leaked before the flag went off",
      rootCause: "Clients getStockLevelDirect checked out while FF_STOCK_DIRECT_QUERY was on are still held after it was turned off at 02:03",
      cites: ["ev_source_3", "ev_commit_3", "ev_commit_2"],
    });
    assert.deepEqual(offFlagProblems(leftover, evidence, { flags: flagsOff, alertAt }), []);
  });

  it("leaves a claim citing a code deploy to the deploy, flag flips beside it or not", () => {
    const deploy = report({
      title: "Formatted price breaks the product API",
      rootCause: "Release 0dfdbac formats the price with an unknown currency; flags flipped at 02:00 too",
      cites: ["ev_commit_4", "ev_commit_3"],
    });
    assert.deepEqual(offFlagProblems(deploy, evidence, { flags: flagsOff, alertAt }), []);
  });

  it("doesn't count source that checks the flag", () => {
    const fromSource = report({
      title: "Stock lookup slow",
      rootCause: "getStockLevel reads stock on every product view",
      cites: ["ev_source_3"],
    });
    assert.deepEqual(offFlagProblems(fromSource, evidence, { flags: flagsOff, alertAt }), []);
  });

  it("leaves a flag turned off within the grace to the alert's window", () => {
    // Off at 02:03, alert at 02:05: the slow requests the alert counted may
    // be the flag's, from while it was on (inc_mw1h5hqk_042470).
    assert.deepEqual(offFlagProblems(tonight, evidence, { flags: flagsOff, alertAt: "2026-11-04T02:05:20.000Z" }), []);
    // An SLO alert's short window, when longer.
    assert.equal(offFlagProblems(tonight, evidence, { flags: flagsOff, alertAt, graceMs: 30 * 60_000 }).length, 1);
    assert.deepEqual(offFlagProblems(tonight, evidence, { flags: flagsOff, alertAt, graceMs: 60 * 60_000 }), []);
  });

  it("takes when the flag went off from the source's history over the evidence", () => {
    const [p] = offFlagProblems(tonight, [turnedOn, stockSource], {
      flags: flagsOff,
      alertAt,
      turnedOffAt: { FF_STOCK_DIRECT_QUERY: "2026-11-04T02:03:04.620Z" },
    });
    assert.match(p, /turned off at 02:03, before the alert/);
    const recent = { flags: flagsOff, alertAt, turnedOffAt: { FF_STOCK_DIRECT_QUERY: "2026-11-04T02:30:00.000Z" } };
    assert.deepEqual(offFlagProblems(tonight, evidence, recent), []);
  });

  it("only checks a root_cause verdict's leading hypothesis", () => {
    assert.deepEqual(offFlagProblems({ ...tonight, verdict: { kind: "healthy", rationale: claim("Cold renders", "ev_metric_1") } }, evidence, { flags: flagsOff, alertAt }), []);
    const elsewhere = { ...tonight, hypotheses: tonight.hypotheses.map((h) => ({ ...h, status: "plausible" as const })) };
    assert.deepEqual(offFlagProblems(elsewhere, evidence, { flags: flagsOff, alertAt }), []);
  });
});

// inc_mw1ky7ti_11e365 (2026-11-04): the API SLO's alert at 03:51:39 on the
// price list gap (FF_LIST_PRICES on 03:32:37 to 03:48:10), its long window
// also holding a pool leak (FF_STOCK_DIRECT_QUERY on at 03:23, turned off at
// 03:25:27 by a mitigation). The report blamed the pool leak. It was the 6×
// alert (6 h and 30 min); the 14.4× one (1 h and 5 min) has the same shape.
describe("offFlagProblems on an SLO alert's burning minutes", () => {
  const sloAlertAt = "2026-11-04T03:51:39.564Z";
  const stockOn = record("ev_commit_11", "config:FF_STOCK_DIRECT_QUERY", "ops: FF_STOCK_DIRECT_QUERY turned on", "2026-11-04T03:23:01.000Z");
  const stockOff = record("ev_commit_12", "config:FF_STOCK_DIRECT_QUERY", "ops: FF_STOCK_DIRECT_QUERY turned off", "2026-11-04T03:25:27.000Z");
  const pricesOn = record("ev_commit_13", "config:FF_LIST_PRICES", "ops: FF_LIST_PRICES turned on", "2026-11-04T03:32:37.000Z");
  const pricesOff = record("ev_commit_14", "config:FF_LIST_PRICES", "ops: FF_LIST_PRICES turned off", "2026-11-04T03:48:10.000Z");
  const sloEvidence: Evidence[] = [stockOn, stockOff, pricesOn, pricesOff, stockSource, latency];
  const poolLeak = report({
    title: "Stock direct query leaks pool connections on missing rows",
    rootCause: "getStockLevelDirect in src/lib/stock.ts, enabled by FF_STOCK_DIRECT_QUERY, returns without releasing its client",
    cites: ["ev_source_3", "ev_commit_11"],
  });
  const priceGap = report({
    title: "List-price gap crash",
    rootCause: "src/lib/prices.ts throws on products with no product_prices row once FF_LIST_PRICES went on at 03:32",
    cites: ["ev_commit_13", "ev_metric_1"],
  });
  const burning = { from: "2026-11-04T03:32:00.000Z", to: "2026-11-04T03:49:00.000Z" };
  const burn = (longMs: number, shortMs: number, withBurning = true) => ({
    rate: 118,
    threshold: longMs === 60 * 60_000 ? 14.4 : 6,
    longMs,
    shortMs,
    budgetLeftPercent: -11723,
    ...(withBurning && { burning }),
  });
  const history: DeployRecord[] = [stockOn, stockOff, pricesOn, pricesOff].map((r) => ({
    service: "shopfront",
    sha: r.sha,
    deployedAt: r.observedAt!,
    kind: "config",
    message: r.message,
  }));
  const sloSource = {
    describe: () => ({ id: "test", now: sloAlertAt, services: [], metrics: [], flags: flagsOff }),
    deployHistory: async () => history,
  } as unknown as TelemetrySource;

  it("rejects a root cause on a flag turned off before the burning minutes, however recently", async () => {
    // 26 min before the alert: inside the 6× alert's 30 min short window,
    // which the 6 h grace and the short-window grace alike let through.
    for (const b of [burn(60 * 60_000, 5 * 60_000), burn(6 * 60 * 60_000, 30 * 60_000)]) {
      const ctx = await flagContext(sloSource, { burn: b });
      const [p, ...rest] = offFlagProblems(poolLeak, sloEvidence, ctx);
      assert.equal(rest.length, 0);
      assert.match(p, /depends on FF_STOCK_DIRECT_QUERY \(it cites ev_commit_11/);
      assert.match(p, /turned off at 03:25 \(ev_commit_12\), before the minutes the alert is burning on \(03:32 to 03:49\)/);
    }
  });

  it("accepts a root cause on a flag that was on during the burning minutes", async () => {
    for (const b of [burn(60 * 60_000, 5 * 60_000), burn(6 * 60 * 60_000, 30 * 60_000)]) {
      assert.deepEqual(offFlagProblems(priceGap, sloEvidence, await flagContext(sloSource, { burn: b })), []);
    }
    // Turned off after the minutes ended, before the alert: still on during them.
    const lateOff = { flags: flagsOff, alertAt: sloAlertAt, burning, turnedOffAt: { FF_LIST_PRICES: "2026-11-04T03:50:00.000Z" } };
    assert.deepEqual(offFlagProblems(priceGap, sloEvidence, lateOff), []);
  });

  it("falls back to the short window's grace when the burning minutes are unknown", async () => {
    // 1 h and 5 min: a 15 min grace, so the flag off 26 min before is checked.
    const hour = await flagContext(sloSource, { burn: burn(60 * 60_000, 5 * 60_000, false) });
    assert.equal(hour.graceMs, GRACE_MS);
    assert.equal(hour.burning, undefined);
    assert.equal(offFlagProblems(poolLeak, sloEvidence, hour).length, 1);
    assert.match(offFlagProblems(poolLeak, sloEvidence, hour)[0], /before the alert at 03:51/);
    assert.deepEqual(offFlagProblems(priceGap, sloEvidence, hour), []);
    // 6 h and 30 min: the 30 min grace leaves it be, as the burning minutes don't.
    const sixHours = await flagContext(sloSource, { burn: burn(6 * 60 * 60_000, 30 * 60_000, false) });
    assert.equal(sixHours.graceMs, 30 * 60_000);
    assert.deepEqual(offFlagProblems(poolLeak, sloEvidence, sixHours), []);
  });
});

describe("flagContext", () => {
  const flipRecord = (flag: string, state: "on" | "off", deployedAt: string): DeployRecord => ({
    service: "shopfront",
    sha: `config:${flag}`,
    deployedAt,
    kind: "config",
    message: `ops: ${flag} turned ${state}`,
  });
  function source(flags: Record<string, boolean> | undefined, records: DeployRecord[] | Error) {
    let reads = 0;
    const s = {
      describe: () => ({ id: "test", now: alertAt, services: [], metrics: [], ...(flags && { flags }) }),
      deployHistory: async () => {
        reads += 1;
        if (records instanceof Error) throw records;
        return records;
      },
    } as unknown as TelemetrySource;
    return { s, reads: () => reads };
  }

  it("reads when each off flag was last turned off", async () => {
    const { s } = source({ FF_STOCK_DIRECT_QUERY: false, FF_LIVE_RATINGS: true }, [
      flipRecord("FF_STOCK_DIRECT_QUERY", "off", "2026-11-04T02:03:04.620Z"),
      flipRecord("FF_STOCK_DIRECT_QUERY", "on", "2026-11-04T02:00:59.265Z"),
      flipRecord("FF_STOCK_DIRECT_QUERY", "off", "2026-11-04T01:00:00.000Z"),
      flipRecord("FF_STOCK_DIRECT_QUERY", "on", "2026-11-04T02:40:00.000Z"),
    ]);
    const ctx = await flagContext(s, {});
    assert.equal(ctx.alertAt, alertAt);
    assert.equal(ctx.graceMs, GRACE_MS);
    assert.deepEqual(ctx.turnedOffAt, { FF_STOCK_DIRECT_QUERY: "2026-11-04T02:03:04.620Z" });
  });

  it("takes a flag off now whose last flip turned it on as just turned off", async () => {
    const { s } = source({ FF_STOCK_DIRECT_QUERY: false }, [flipRecord("FF_STOCK_DIRECT_QUERY", "on", "2026-11-04T02:00:59.265Z")]);
    const ctx = await flagContext(s, {});
    assert.deepEqual(ctx.turnedOffAt, { FF_STOCK_DIRECT_QUERY: alertAt });
    assert.deepEqual(offFlagProblems(tonight, evidence, ctx), []);
  });

  it("skips the history when no flag is off, and widens the grace to an SLO alert's short window", async () => {
    const on = source({ FF_STOCK_DIRECT_QUERY: true }, []);
    await flagContext(on.s, {});
    assert.equal(on.reads(), 0);
    const unknown = source(undefined, []);
    assert.deepEqual(await flagContext(unknown.s, {}), { flags: undefined, alertAt, graceMs: GRACE_MS });
    const burn = { rate: 20, threshold: 14.4, longMs: 60 * 60_000, shortMs: 5 * 60_000, budgetLeftPercent: 90 };
    assert.equal((await flagContext(on.s, { burn })).graceMs, GRACE_MS);
    const sixX = { ...burn, threshold: 6, longMs: 6 * 60 * 60_000, shortMs: 30 * 60_000 };
    assert.equal((await flagContext(on.s, { burn: sixX })).graceMs, 30 * 60_000);
    const burning = { from: "2026-11-04T02:20:00.000Z", to: "2026-11-04T02:35:00.000Z" };
    assert.deepEqual((await flagContext(on.s, { burn: { ...burn, burning } })).burning, burning);
  });

  it("falls back to the evidence when the history can't be read", async () => {
    const { s } = source({ FF_STOCK_DIRECT_QUERY: false }, new Error("collector down"));
    const ctx = await flagContext(s, {});
    assert.deepEqual(ctx.turnedOffAt, {});
    assert.match(offFlagProblems(tonight, evidence, ctx)[0], /turned off at 02:03 \(ev_commit_2\)/);
  });
});
