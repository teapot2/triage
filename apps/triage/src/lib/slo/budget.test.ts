import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sloBudget, sloBudgetRows } from "../export/datasets/slo";
import type { WatchRule } from "../investigation/watch-rule-model";
import { summarize } from "../live/snapshot";
import { sloBudgets } from "./budget";
import { budgetLeftText, overspentText } from "./model";
import type { CountsFn } from "./rollups";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const now = Date.parse("2026-11-02T12:00:00.000Z");

const slo = (o: Partial<WatchRule> = {}): WatchRule => ({
  id: "api-slo",
  name: "API SLO",
  enabled: true,
  target: { kind: "api" },
  condition: { metric: "slo", objectivePercent: 99.9, windowDays: 30 },
  windowSeconds: 60,
  checksToOpen: 2,
  minRequests: 5,
  severity: "sev2",
  ...o,
});

// Per route, 100 requests a minute for the last 10 days, all failing in
// the hour that ended `badHoursAgo` hours ago.
type Traffic = { badHoursAgo?: number };
function counts(routes: Record<string, Traffic>): CountsFn {
  return (route, from, to) => {
    const t = routes[route];
    if (!t) return { total: 0, good: 0 };
    const minutes = (a: number, b: number) => Math.max(0, Math.min(b, to, now) - Math.max(a, from, now - 10 * DAY)) / MINUTE;
    const total = minutes(-Infinity, Infinity) * 100;
    const end = now - (t.badHoursAgo ?? 0) * HOUR;
    const bad = t.badHoursAgo === undefined ? 0 : minutes(end - HOUR, end) * 100;
    return { total, good: total - bad };
  };
}

describe("sloBudgets", () => {
  // 1,440,000 requests, so 1440 may fail: an hour of failures (6000) is
  // over 4 times the budget.
  const traffic = counts({
    "/api/a": {},
    // 5 days ago.
    "/api/b": { badHoursAgo: 120 },
    // Failing for the last hour.
    "/api/c": { badHoursAgo: 0 },
    "/journal": { badHoursAgo: 0 },
  });
  const routes = ["/api/a", "/api/b", "/api/c", "/journal", "/api/quiet"].map((route) => ({ route, method: "GET" }));
  const [budget] = sloBudgets([slo()], routes, traffic, now);

  it("lists the routes it covers with traffic, lowest budget first", () => {
    assert.deepEqual(
      budget.routes.map((r) => [r.route, r.budgetLeftPercent, r.requests]),
      [
        ["/api/b", -316.7, 1_440_000],
        ["/api/c", -316.7, 1_440_000],
        ["/api/a", 100, 1_440_000],
      ],
    );
    assert.deepEqual(
      [budget.ruleId, budget.objectivePercent, budget.windowDays, "latencyMs" in budget],
      ["api-slo", 99.9, 30, false],
    );
  });

  it("gives each route its burn over 1 and 6 hours, and the alert firing on it", () => {
    const c = budget.routes.find((r) => r.route === "/api/c")!;
    assert.deepEqual([c.burn1h, c.burn6h, c.alert], [1000, 166.67, "fast"]);
    const b = budget.routes.find((r) => r.route === "/api/b")!;
    // Long past: its last 6 hours are clean, so not even the slow alert
    // fires.
    assert.deepEqual([b.burn1h, b.burn6h, b.alert], [0, 0, undefined]);
  });

  it("draws the lowest route's burndown: flat, a step down where the budget went, ending at what's left", () => {
    const points = budget.burndown;
    assert.equal(points.length, 121);
    // Before the counts begin, 10 days ago, nothing to draw.
    assert.equal(points[0].value, null);
    const values = points.flatMap((p) => (p.value === null ? [] : [p.value]));
    assert.equal(values[0], 100);
    assert.equal(values.at(-1), -316.7);
    for (let i = 1; i < values.length; i++) assert.ok(values[i] <= values[i - 1], "never rises");
  });

  it("skips rules that aren't enabled SLOs, and keeps an SLO with no traffic to say so", () => {
    const rules = [slo({ enabled: false }), slo({ id: "p95", condition: { metric: "p95", aboveMs: 500 } }), slo({ id: "idle", target: { kind: "route", route: "/api/none" } })];
    const budgets = sloBudgets(rules, routes, traffic, now);
    assert.deepEqual(
      budgets.map((b) => [b.ruleId, b.routes.length, b.burndown.length]),
      [["idle", 0, 0]],
    );
  });

  it("exports a row per rule and route", () => {
    const rows = sloBudgetRows([budget]);
    assert.equal(rows.length, 3);
    assert.deepEqual(
      sloBudget.columns.map((c) => c.value(rows[0])),
      ["API SLO", "GET", "/api/b", 99.9, 30, undefined, 1_440_000, -316.7, 0, 0, undefined],
    );
  });

  it("puts each covered route's lowest budget in the snapshot's route table", () => {
    const snapshot = summarize(
      {
        spans: [
          {
            traceId: "t1",
            spanId: "s1",
            service: "shopfront",
            scope: "next.js",
            name: "GET /api/b",
            kind: 2,
            start: now - 30_000,
            end: now - 29_950,
            error: false,
            attributes: { "http.route": "/api/b", "http.status_code": 200 },
            events: [],
          },
        ],
        logs: [],
        metrics: [],
        rules: [slo()],
        incidents: [],
        slos: [budget],
      },
      "shopfront",
      "5m",
      now,
    );
    assert.deepEqual(snapshot.slos, [budget]);
    assert.deepEqual(
      snapshot.routes.map((r) => [r.route, r.budgetLeftPercent]),
      [["/api/b", -316.7]],
    );
  });
});

// Nov 4: after a few outages the sidebar read "-10312% of budget left".
describe("budgetLeftText", () => {
  it("says what's left, and an overspent budget as a multiple", () => {
    assert.equal(budgetLeftText(71.4), "71% of budget left");
    assert.equal(budgetLeftText(0), "0% of budget left");
    assert.equal(budgetLeftText(-10312), "spent 104× its budget");
    assert.equal(budgetLeftText(-316.7), "spent 4.2× its budget");
    assert.equal(overspentText(-50), "1.5×");
  });
});
