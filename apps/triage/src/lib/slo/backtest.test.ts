import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { closeDb, getDb } from "../db";
import type { RequestSample } from "../investigation/live/live-source";
import { backtestRule } from "../investigation/watch-judge";
import type { WatchRule } from "../investigation/watch-rule-model";
import { backtestSloRule, type History, historyCounts, loadHistory } from "./backtest";
import { countsIn, rollUp } from "./rollups";

// backtest.ts on a temp working directory, so .data/triage.db is ours.
const cwd = process.cwd();
let dir: string;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "triage-slo-backtest-"));
  process.chdir(dir);
});
after(async () => {
  closeDb();
  process.chdir(cwd);
  await rm(dir, { recursive: true, force: true });
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const t = (iso: string) => Date.parse(iso);

function req(start: number, o: Partial<RequestSample> = {}): RequestSample {
  return {
    service: "shopfront",
    route: "/api/a",
    method: "GET",
    start,
    durationMs: 50,
    status: 200,
    failed: false,
    traceId: `t${start}`,
    ...o,
  };
}

const rule = (o: Partial<WatchRule> = {}): WatchRule => ({
  id: "r",
  name: "R",
  enabled: true,
  target: { kind: "api" },
  condition: { metric: "slo", objectivePercent: 99.9, windowDays: 30 },
  windowSeconds: 60,
  checksToOpen: 2,
  minRequests: 5,
  severity: "sev2",
  ...o,
});

describe("loadHistory", () => {
  it("joins hourly summaries, rolled-up minutes and the requests since, and counts as countsIn does", () => {
    const service = "svc-history";
    const db = getDb();
    const h = t("2026-08-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO request_hourly (service, route, method, hour, total, failed, ok_100, ok_250, ok_500, ok_1000, ok_2500) VALUES (?, '/api/a', 'GET', ?, 100, 10, 50, 60, 80, 85, 90)",
    ).run(service, h);
    // Two methods in one minute, then a minute rolled up after.
    rollUp(
      db,
      [
        req(h + 2 * HOUR + 1_000, { service }),
        req(h + 2 * HOUR + 2_000, { service, method: "POST", failed: true, status: 500 }),
        req(h + 2 * HOUR + MINUTE + 1_000, { service, durationMs: 300 }),
      ],
      h + 2 * HOUR - MINUTE,
      h + 3 * HOUR,
      HOUR,
    );
    const through = h + 2 * HOUR + 2 * MINUTE;
    const samples = [req(through + 5_000, { service, method: "POST" })];

    const history = loadHistory(service, undefined, samples, through, h);
    assert.deepEqual(history.get("/api/a"), {
      method: "POST",
      buckets: [
        { t: h, total: 100, good: 90 },
        { t: h + 2 * HOUR, total: 2, good: 1 },
        { t: h + 2 * HOUR + MINUTE, total: 1, good: 1 },
        { t: through, total: 1, good: 1 },
      ],
    });
    const latency = loadHistory(service, 250, samples, through, h).get("/api/a")!.buckets;
    assert.deepEqual(
      latency.map((b) => b.good),
      [60, 1, 0, 1],
    );
    // Summed from memory as countsIn sums the table (the sample aside).
    const counts = historyCounts(history);
    const window = { service, route: "/api/a", from: h, to: through };
    assert.deepEqual(counts("/api/a", window.from, window.to), countsIn(window));
    assert.deepEqual(counts("/api/a", h + 2 * HOUR + MINUTE, through + MINUTE), { total: 2, good: 2 });
    assert.deepEqual(counts("/api/none", h, through), { total: 0, good: 0 });
  });
});

describe("backtestSloRule", () => {
  // 100 requests a minute for 4 days, with half failing for 10 minutes
  // twice: 12 hours ago and 4 hours ago.
  const now = t("2026-11-02T12:00:00.000Z");
  const outages = [now - 12 * HOUR, now - 4 * HOUR];
  const history: History = new Map([
    [
      "/api/a",
      {
        method: "GET",
        buckets: Array.from({ length: 4 * 24 * 60 }, (_, i) => {
          const m = now - 4 * DAY + i * MINUTE;
          const bad = outages.some((o) => m >= o && m < o + 10 * MINUTE) ? 50 : 0;
          return { t: m, total: 100, good: 100 - bad };
        }),
      },
    ],
  ]);

  // The first outage leaves the 3-day burn over 1x for the second, so the
  // slow alert fires on its first bad minute; its hold lets the fast alert
  // open it, a minute later, at the rule's severity.
  it("opens once per outage, at the fast alert, and replays every 10 seconds of the range", () => {
    const r = backtestSloRule(rule(), history, now - DAY, now);
    assert.equal(r.checks, 8640);
    assert.deepEqual(
      r.fired.map((f) => f.at),
      // The first check whose 5-minute window takes in a whole bad minute.
      outages.map((o) => new Date(o + MINUTE + 10_000).toISOString()),
    );
    for (const f of r.fired) assert.match(f.summary!, /^burning \d+(\.\d)?× over 1 h on \/api\/a/);
    assert.equal(r.dataFrom, undefined);
  });

  // Two outages 3 hours apart: the first's slow burn still fires (its 6 h
  // window holds the bad minutes) when the second starts, and the second's
  // fast burn, quiet for hours, fires again as the live watch opens a new
  // incident for it.
  it("fires again for a fast burn in the slow-burn tail of an earlier outage", () => {
    const close = [now - 6 * HOUR, now - 3 * HOUR];
    const twice: History = new Map([
      [
        "/api/a",
        {
          method: "GET",
          buckets: Array.from({ length: 4 * 24 * 60 }, (_, i) => {
            const m = now - 4 * DAY + i * MINUTE;
            const bad = close.some((o) => m >= o && m < o + 10 * MINUTE) ? 50 : 0;
            return { t: m, total: 100, good: 100 - bad };
          }),
        },
      ],
    ]);
    const r = backtestSloRule(rule(), twice, now - DAY, now);
    assert.equal(r.fired.length, 2);
    // On its first bad minute, by the 6 h alert, whose long window still
    // holds the first outage and whose 30 minutes are the second's alone.
    assert.equal(r.fired[1].at, new Date(close[1] + 10_000).toISOString());
    assert.match(r.fired[1].summary!, /^burning \d+(\.\d)?× over 6 h on \/api\/a/);
  });

  it("says when the counts start after the range does", () => {
    const short: History = new Map([["/api/a", { method: "GET", buckets: [{ t: now - HOUR, total: 100, good: 100 }] }]]);
    const r = backtestSloRule(rule(), short, now - DAY, now);
    assert.equal(r.dataFrom, new Date(now - HOUR).toISOString());
    assert.deepEqual(r.fired, []);
  });
});

describe("backtestRule", () => {
  it("still replays a threshold rule with its streaks and episodes", () => {
    const now = t("2026-11-02T12:00:00.000Z");
    // A request every second; slow (900 ms) from 30 to 32 minutes in.
    const samples = Array.from({ length: 60 * 60 }, (_, i) =>
      req(now - HOUR + i * 1000, { durationMs: i >= 30 * 60 && i < 32 * 60 ? 900 : 50 }),
    );
    const r = backtestRule(
      rule({ condition: { metric: "p95", aboveMs: 500 }, windowSeconds: 60, checksToOpen: 2 }),
      samples,
      now - HOUR,
      now,
    );
    assert.equal(r.checks, 360);
    assert.equal(r.fired.length, 1);
    assert.equal(r.fired[0].route, "/api/a");
  });
});
