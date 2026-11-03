import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { burnSeries } from "../investigation/live/live-source";
import type { SpanRow } from "../investigation/live/otlp-files";
import {
  burnMetric,
  conditionText,
  defaultRules,
  describeRule,
  ruleSchema,
  rulesSchema,
  tripMetric,
  tripTitle,
  type WatchRule,
} from "../investigation/watch-rule-model";
import { evaluateSloRule, SLOW_BURN_HOLD_MS } from "./judge";
import { budgetLeftPercent, burnAlerts, burnRate, burnText, burnThreshold, durationText } from "./model";
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

// Traffic per route as minutes: `perMinute` requests every minute for the
// last 4 days, and `bad` of them failing in the minutes `badFrom` to
// `badTo` minutes ago (counted back from now).
type Traffic = { perMinute: number; bad?: number; badFrom?: number; badTo?: number };
function counts(routes: Record<string, Traffic>): CountsFn {
  return (route, from, to) => {
    const t = routes[route];
    if (!t) return { total: 0, good: 0 };
    let [total, good] = [0, 0];
    for (let m = now - 4 * DAY; m < now; m += MINUTE) {
      if (m < from || m >= to) continue;
      const ago = (now - m) / MINUTE;
      const bad = t.bad && ago <= (t.badFrom ?? 0) && ago > (t.badTo ?? 0) ? t.bad : 0;
      total += t.perMinute;
      good += t.perMinute - bad;
    }
    return { total, good };
  };
}

const api = (route: string, method = "GET") => ({ route, method });

describe("SLO burn math", () => {
  it("scales the Workbook's thresholds to the SLO window", () => {
    assert.deepEqual(
      burnAlerts.map((a) => burnThreshold(a, 30)),
      [14.4, 6, 1],
    );
    assert.deepEqual(
      burnAlerts.map((a) => burnThreshold(a, 7)),
      [3.36, 1.4, 0.23],
    );
  });

  it("burns 1x when the bad share is exactly what the objective allows", () => {
    assert.equal(Math.round(burnRate({ total: 1000, good: 999 }, 99.9) * 1000) / 1000, 1);
    assert.equal(burnRate({ total: 0, good: 0 }, 99.9), 0);
    assert.equal(Math.round(budgetLeftPercent({ total: 10_000, good: 9_997 }, 99.9)), 70);
    assert.equal(Math.round(budgetLeftPercent({ total: 1000, good: 990 }, 99.9)), -900);
  });

  it("says it in words", () => {
    assert.deepEqual([burnText(83.33), burnText(14.4), burnText(0.868)], ["83.3×", "14.4×", "0.87×"]);
    assert.deepEqual([durationText(5 * MINUTE), durationText(6 * HOUR), durationText(3 * DAY)], ["5 min", "6 h", "3 days"]);
  });
});

describe("SLO rules in the rule model", () => {
  it("reads the SLO back in words, as a title and as the series it charts", () => {
    const rule = slo({ condition: { metric: "slo", objectivePercent: 99.5, windowDays: 28, latencyMs: 500 } });
    assert.equal(conditionText(rule.condition), "99.5% of requests succeed within 500 ms over 28 days");
    assert.equal(describeRule(slo()), "99.9% of requests succeed over 30 days on each API route");
    assert.equal(tripTitle(rule, "GET", "/api/x", 83.33), "Error budget burning 83.3× on GET /api/x");
    assert.deepEqual(tripMetric(rule, "/api/x", 14.4), { metric: "slo.burn_rate{route=/api/x,objective=99.5,le=500}", threshold: 14.4 });
    assert.equal(burnMetric("/api/x", 99.9), "slo.burn_rate{route=/api/x,objective=99.9}");
  });

  it("keeps rules saved before SLOs valid, and refuses a window or latency it can't count", () => {
    assert.equal(rulesSchema.safeParse(defaultRules).success, true);
    assert.equal(ruleSchema.safeParse(slo()).success, true);
    const bad = (condition: object) => ruleSchema.safeParse({ ...slo(), condition }).success;
    assert.equal(bad({ metric: "slo", objectivePercent: 99.9, windowDays: 31 }), false);
    assert.equal(bad({ metric: "slo", objectivePercent: 99.9, windowDays: 30, latencyMs: 300 }), false);
    assert.equal(bad({ metric: "slo", objectivePercent: 100, windowDays: 30 }), false);
  });
});

describe("evaluateSloRule", () => {
  it("is ok on a healthy route, with what's left of the budget", () => {
    const r = evaluateSloRule(slo(), [api("/api/a")], counts({ "/api/a": { perMinute: 100 } }), now);
    assert.deepEqual(r, { status: "ok", summary: "100% of budget left on /api/a", budgetLeftPercent: 100 });
  });

  it("trips the 1 h alert on a fast burn, at the rule's severity", () => {
    // Half the requests failing for the last 10 minutes.
    const r = evaluateSloRule(slo(), [api("/api/a")], counts({ "/api/a": { perMinute: 1000, bad: 500, badFrom: 10 } }), now);
    assert.equal(r.status, "breaching");
    assert.equal(r.checks, 1);
    assert.equal(r.trip?.route, "/api/a");
    assert.equal(r.trip?.severity, undefined);
    assert.equal(r.trip?.burn?.threshold, 14.4);
    assert.equal(r.trip?.burn?.longMs, HOUR);
    assert.equal(Math.round(r.trip!.burn!.rate), 83);
    assert.match(r.summary!, /^burning 83.3× over 1 h on \/api\/a · 13% of budget left$/);
  });

  it("stands the 1 h alert down once the 5 minutes are clean, while the 6 h one still fires", () => {
    const r = evaluateSloRule(
      slo(),
      [api("/api/a")],
      counts({ "/api/a": { perMinute: 1000, bad: 500, badFrom: 16, badTo: 6 } }),
      now,
    );
    assert.equal(r.trip?.burn?.longMs, 6 * HOUR);
    assert.equal(r.trip?.burn?.threshold, 6);
  });

  it("leaves a big outage to the slow alert once the 30 minutes are clean, at sev4 once it has held", () => {
    const traffic = counts({ "/api/a": { perMinute: 1000, bad: 500, badFrom: 45, badTo: 35 } });
    const held = new Map<string, number>();
    const first = evaluateSloRule(slo(), [api("/api/a")], traffic, now, held);
    // Firing, not yet opening: a fast burn starting now would trip first.
    assert.equal(first.status, "breaching");
    assert.equal(first.trip, undefined);
    assert.equal(first.checks, undefined);
    assert.match(first.summary!, /^burning 1.2× over 3 days on \/api\/a/);
    assert.deepEqual([...held], [["api-slo|/api/a|slow", now]]);

    const r = evaluateSloRule(slo(), [api("/api/a")], traffic, now, new Map([["api-slo|/api/a|slow", now - SLOW_BURN_HOLD_MS]]));
    assert.equal(r.trip?.burn?.longMs, 3 * DAY);
    assert.equal(r.trip?.severity, "sev4");
  });

  it("forgets a slow burn's start once it stops firing", () => {
    const held = new Map([["api-slo|/api/a|slow", now - HOUR]]);
    evaluateSloRule(slo(), [api("/api/a")], counts({ "/api/a": { perMinute: 1000 } }), now, held);
    assert.equal(held.size, 0);
  });

  it("stays quiet on a blip that spends little of the budget", () => {
    const r = evaluateSloRule(slo(), [api("/api/a")], counts({ "/api/a": { perMinute: 1000, bad: 200, badFrom: 2 } }), now);
    assert.equal(r.status, "ok");
    assert.equal(r.trip, undefined);
  });

  it("doesn't judge a window with fewer than minRequests", () => {
    const r = evaluateSloRule(
      slo({ minRequests: 4000 }),
      [api("/api/a")],
      counts({ "/api/a": { perMinute: 1, bad: 1, badFrom: 30 } }),
      now,
      new Map([["api-slo|/api/a|slow", now - SLOW_BURN_HOLD_MS]]),
    );
    // Only the 3-day window has 4000 requests, so only the slow alert
    // judges it.
    assert.equal(r.status, "breaching");
    assert.equal(r.trip?.burn?.longMs, 3 * DAY);
    const idle = evaluateSloRule(slo({ minRequests: 10_000 }), [api("/api/a")], counts({ "/api/a": { perMinute: 1 } }), now);
    assert.deepEqual(idle, { status: "idle", summary: undefined, budgetLeftPercent: undefined });
  });

  it("judges only the routes its target covers, and prefers a fast burn on one to a slow burn on another", () => {
    const traffic = counts({
      "/api/slow": { perMinute: 1000, bad: 500, badFrom: 45, badTo: 35 },
      "/api/fast": { perMinute: 1000, bad: 500, badFrom: 10 },
      "/journal": { perMinute: 1000, bad: 1000, badFrom: 60 },
    });
    const r = evaluateSloRule(slo(), [api("/api/slow"), api("/api/fast", "POST"), api("/journal")], traffic, now);
    assert.deepEqual([r.trip?.route, r.trip?.method, r.trip?.severity], ["/api/fast", "POST", undefined]);
    // The lowest budget of the two it judged.
    assert.equal(Math.round(r.budgetLeftPercent!), 13);
  });

  it("is paused while disabled", () => {
    assert.deepEqual(evaluateSloRule(slo({ enabled: false }), [], counts({}), now), { status: "paused" });
  });
});

describe("burnSeries", () => {
  const span = (start: number, o: { route?: string; ms?: number; status?: number } = {}): SpanRow => ({
    traceId: `t${start}`,
    spanId: `s${start}`,
    service: "shopfront",
    scope: "next.js",
    name: "GET /api/a",
    kind: 2,
    start,
    end: start + (o.ms ?? 50),
    error: false,
    attributes: { "http.route": o.route ?? "/api/a", "http.status_code": o.status ?? 200 },
    events: [],
  });
  const f = {
    failed: (s: SpanRow) => Number(s.attributes["http.status_code"]) >= 500,
    duration: (s: SpanRow) => s.end - s.start,
  };
  const at = Date.parse("2026-11-02T12:00:30.000Z");

  it("charts each minute's burn over the 5 minutes to its end", () => {
    const spans = [
      // Five minutes ago: 4 good, 1 slow; a minute ago: 1 failed, 1 good.
      ...[1, 2, 3, 4].map((i) => span(at - 5 * MINUTE + i)),
      span(at - 5 * MINUTE + 5, { ms: 900 }),
      span(at - MINUTE, { status: 500 }),
      span(at - MINUTE + 1),
      span(at - MINUTE + 2, { route: "/api/b", status: 500 }),
    ];
    const availability = burnSeries("slo.burn_rate{route=/api/a,objective=99}", spans, at, f)!;
    assert.equal(availability.unit, "×");
    const points = availability.points(6);
    // 12:00 covers 11:56 to 12:01: 1 bad of 2 (the 11:55 requests are out).
    assert.deepEqual(points.at(-1), { t: "2026-11-02T12:00:00.000Z", value: 50 });
    // 11:55 covers 11:51 to 11:56: none bad of 5.
    assert.deepEqual(points[0], { t: "2026-11-02T11:55:00.000Z", value: 0 });
    const latency = burnSeries("slo.burn_rate{route=/api/a,objective=99,le=500}", spans, at, f)!;
    // The 900 ms request is bad too.
    assert.deepEqual(latency.points(6)[0], { t: "2026-11-02T11:55:00.000Z", value: 20 });
  });

  it("answers only to a burn-rate name", () => {
    assert.equal(burnSeries("http.server.error_ratio{route=/api/a}", [], at, f), undefined);
    assert.equal(burnSeries("slo.burn_rate{route=/api/a,objective=100}", [], at, f), undefined);
  });
});
