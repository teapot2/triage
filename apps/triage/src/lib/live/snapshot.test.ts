import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MetricRow, SpanRow } from "@/lib/investigation/live/otlp-files";
import { defaultRules } from "@/lib/investigation/watch-rule-model";
import { type SnapshotInput, summarize } from "./snapshot";

// 5m window: 5s buckets. NOW is on a bucket edge plus a little, so the
// bucket math is easy to follow: the newest charted bucket ends at
// floor((NOW - 2s lag) / 5s) * 5s.
const NOW = Date.UTC(2026, 9, 28, 6, 0, 0) + 3_000;
const END = Date.UTC(2026, 9, 28, 6, 0, 0);
const START = END - 5 * 60_000;

function request(start: number, o: Partial<{ route: string; ms: number; status: number; service: string }> = {}): SpanRow {
  return {
    traceId: `t${start}`,
    spanId: `s${start}`,
    service: o.service ?? "shopfront",
    scope: "next.js",
    name: `GET ${o.route ?? "/api/products"}`,
    kind: 2,
    start,
    end: start + (o.ms ?? 10),
    error: false,
    attributes: { "http.route": o.route ?? "/api/products", "http.method": "GET", "http.status_code": o.status ?? 200 },
    events: [],
  };
}

const used = (time: number, value: number): MetricRow => ({
  name: "db.client.connection.count",
  service: "shopfront",
  unit: "{connection}",
  description: "",
  time,
  value,
  attributes: { "db.client.connection.state": "used" },
});

const input = (o: Partial<SnapshotInput>): SnapshotInput => ({
  spans: [],
  logs: [],
  metrics: [],
  // Every default on, the paused API latency rule included, for its limit.
  rules: defaultRules.map((r) => ({ ...r, enabled: true })),
  incidents: [],
  ...o,
});

const at = (series: { t: string; value: number | null }[], time: number) =>
  series.find((p) => p.t === new Date(time).toISOString())?.value;

describe("summarize", () => {
  it("has one point per bucket across the window, ending before the lag", () => {
    const s = summarize(input({}), "shopfront", "5m", NOW);
    assert.equal(s.series.perSecond.length, 60);
    assert.equal(s.series.perSecond[0].t, new Date(START).toISOString());
    assert.equal(s.series.perSecond.at(-1)?.t, new Date(END - 5_000).toISOString());
  });

  it("leaves gaps where there's nothing to measure, and zero traffic as zero", () => {
    const s = summarize(input({ spans: [request(END - 10_000)] }), "shopfront", "5m", NOW);
    assert.equal(at(s.series.perSecond, END - 20_000), 0);
    assert.equal(at(s.series.p95Ms, END - 20_000), null);
    assert.equal(at(s.series.errorPercent, END - 20_000), null);
    assert.equal(at(s.series.p95Ms, END - 10_000), 10);
  });

  it("charts only complete buckets but lists the newest requests in the feed", () => {
    const young = NOW - 500;
    const s = summarize(input({ spans: [request(END - 10_000), request(young)] }), "shopfront", "5m", NOW);
    assert.equal(s.series.perSecond.reduce((n, p) => n + (p.value ?? 0), 0) * 5, 1);
    assert.equal(s.requests[0].time, young);
    assert.equal(s.requests.length, 2);
  });

  it("handles rows out of time order", () => {
    const spans = [request(END - 10_000, { ms: 30 }), request(END - 60_000, { ms: 20 }), request(END - 9_000, { ms: 40 })];
    const s = summarize(input({ spans }), "shopfront", "5m", NOW);
    assert.deepEqual(
      s.requests.map((r) => r.time),
      [END - 9_000, END - 10_000, END - 60_000],
    );
    assert.equal(at(s.series.p95Ms, END - 10_000), 40);
  });

  it("counts 5xx as errors and judges each route by its own rule", () => {
    const spans = [
      request(END - 10_000, { route: "/api/slow", ms: 900 }),
      request(END - 10_000 + 1, { route: "/api/slow", ms: 900, status: 500 }),
      request(END - 10_000 + 2, { route: "/", ms: 900 }),
    ];
    const s = summarize(input({ spans }), "shopfront", "5m", NOW);
    assert.equal(at(s.series.errorPercent, END - 10_000), 33.3);
    const slow = s.routes.find((r) => r.route === "/api/slow");
    assert.equal(slow?.errorPercent, 50);
    assert.equal(slow?.limitMs, 500);
    // Pages have no p95 rule by default (theirs counts slow requests).
    assert.equal(s.routes.find((r) => r.route === "/")?.limitMs, undefined);
  });

  it("sums up the whole window apart from the last 30 seconds", () => {
    const spans = [
      request(END - 200_000, { ms: 900, status: 500 }),
      request(END - 10_000, { ms: 20 }),
      request(END - 9_000, { ms: 30 }),
      request(END - 8_000, { ms: 40 }),
    ];
    const metrics = [used(END - 120_000, 4), used(END - 30_000, 1)];
    const s = summarize(input({ spans, metrics }), "shopfront", "5m", NOW);
    assert.deepEqual(s.overall, { perSecond: 0.01, p95Ms: 900, errorPercent: 25, poolPeak: 4 });
    assert.equal(s.now.p95Ms, 40);
    assert.equal(s.now.errorPercent, 0);
    assert.equal(s.now.poolUsed, 1);
  });

  it("leaves the window's figures out when there's nothing to sum up", () => {
    const s = summarize(input({}), "shopfront", "5m", NOW);
    assert.deepEqual(s.overall, { perSecond: 0, p95Ms: undefined, errorPercent: undefined, poolPeak: undefined });
  });

  it("draws the watch rules' limits only for the service they watch", () => {
    const spans = [request(END - 10_000, { route: "/api/slow", ms: 900, service: "checkout-api" })];
    const s = summarize(input({ spans }), "checkout-api", "5m", NOW);
    assert.deepEqual(s.limits, { p95Ms: undefined, errorPercent: undefined, poolMax: undefined });
    assert.equal(s.routes[0]?.limitMs, undefined);
  });

  it("ignores other services and the demo harness", () => {
    const spans = [request(END - 10_000, { service: "other" }), request(END - 10_000, { route: "/api/ops" })];
    const s = summarize(input({ spans }), "shopfront", "5m", NOW);
    assert.equal(s.requests.length, 0);
    assert.equal(s.lastDataAt, END - 10_000 + 10);
  });

  it("carries the pool reading forward between exports", () => {
    const metrics = [used(END - 30_000, 3), used(START - 1_000, 1)];
    const s = summarize(input({ metrics }), "shopfront", "5m", NOW);
    assert.equal(at(s.series.poolUsed, START), 1);
    assert.equal(at(s.series.poolUsed, END - 35_000), 1);
    assert.equal(at(s.series.poolUsed, END - 30_000), 3);
    assert.equal(at(s.series.poolUsed, END - 5_000), 3);
    assert.equal(s.now.poolUsed, 3);
  });

  it("peaks the requests waiting for a pool connection per bucket", () => {
    const connect = (start: number, end: number): SpanRow => ({
      ...request(start),
      spanId: `c${start}`,
      scope: "pg-pool",
      kind: 1,
      name: "pg-pool.connect",
      end,
      attributes: {},
    });
    const t = END - 20_000;
    const spans = [connect(t + 100, t + 3_000), connect(t + 200, t + 1_000), connect(t + 2_000, t + 2_500)];
    const s = summarize(input({ spans }), "shopfront", "5m", NOW);
    assert.equal(at(s.series.poolWaiting, t), 2);
    assert.equal(at(s.series.poolWaiting, t + 5_000), 0);
  });

  it("marks incidents opened on the service in the window", () => {
    const incident = (id: string, detectedAt: number, service = "shopfront") => ({
      id,
      title: id,
      service,
      detectedAt: new Date(detectedAt).toISOString(),
      trigger: {},
    });
    const incidents = [incident("old", START - 1), incident("in", END - 1_000), incident("elsewhere", END - 1_000, "other")];
    const s = summarize(input({ incidents }), "shopfront", "5m", NOW);
    assert.deepEqual(
      s.incidents.map((i) => i.id),
      ["in"],
    );
  });
});
