import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { closeDb, getDb } from "../db";
import type { RequestSample } from "../investigation/live/live-source";
import { bucketMinutes, countsIn, MINUTE_DAYS, pruneRollups, rollUp, routesSince, SETTLE_MS } from "./rollups";

// rollups.ts on a temp working directory, so .data/triage.db is ours.
// Rewrites and prunes are database-wide, so each test sits in its own
// stretch of time, and reads by its own service.
const cwd = process.cwd();
let dir: string;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "triage-rollups-"));
  process.chdir(dir);
});
after(async () => {
  closeDb();
  process.chdir(cwd);
  await rm(dir, { recursive: true, force: true });
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const t = (iso: string, plusMs = 0) => Date.parse(iso) + plusMs;

function req(start: number, o: Partial<RequestSample> = {}): RequestSample {
  return {
    service: "shopfront",
    route: "/api/products/[id]",
    method: "GET",
    start,
    durationMs: 50,
    status: 200,
    failed: false,
    traceId: `t${start}`,
    ...o,
  };
}

const minutesOf = (service: string) =>
  getDb()
    .prepare("SELECT route, minute, total, failed, ok_500 FROM request_minutes WHERE service = ? ORDER BY minute, route")
    .all(service)
    .map((r) => ({ ...r }));

describe("bucketMinutes", () => {
  it("counts per route and minute, failures apart from every latency bucket", () => {
    const m = t("2026-11-01T10:00:00.000Z");
    const rows = bucketMinutes(
      [
        req(m + 1_000, { durationMs: 100 }),
        req(m + 2_000, { durationMs: 101 }),
        req(m + 3_000, { durationMs: 2600 }),
        req(m + 4_000, { durationMs: 10, failed: true, status: 500 }),
        req(m + 5_000, { route: "/api/products" }),
        req(m + MINUTE, { durationMs: 500 }),
      ],
      m,
      m + 2 * MINUTE,
    );
    assert.deepEqual(rows, [
      { service: "shopfront", route: "/api/products", method: "GET", minute: m, total: 1, failed: 0, ok: [1, 1, 1, 1, 1] },
      { service: "shopfront", route: "/api/products/[id]", method: "GET", minute: m, total: 4, failed: 1, ok: [1, 2, 2, 2, 2] },
      { service: "shopfront", route: "/api/products/[id]", method: "GET", minute: m + MINUTE, total: 1, failed: 0, ok: [0, 0, 1, 1, 1] },
    ]);
  });

  it("takes the requests in [from, to)", () => {
    const m = t("2026-11-01T10:00:00.000Z");
    const rows = bucketMinutes([req(m - 1), req(m), req(m + MINUTE - 1), req(m + MINUTE)], m, m + MINUTE);
    assert.deepEqual(
      rows.map((r) => [r.minute, r.total]),
      [[m, 2]],
    );
  });
});

describe("rollUp", () => {
  it("writes only settled minutes, and a later pass counts late spans without counting twice", () => {
    const service = "svc-late";
    const m = t("2026-11-01T11:00:00.000Z");
    const early = [req(m + 1_000, { service }), req(m + MINUTE + 1_000, { service })];
    // 20 s into the third minute: the second hasn't settled.
    const now = m + 2 * MINUTE + 20_000;
    assert.deepEqual(rollUp(getDb(), early, m - HOUR, now), { from: m - 3 * MINUTE, to: m + MINUTE });
    assert.deepEqual(
      minutesOf(service).map((r) => [r.minute, r.total]),
      [[m, 1]],
    );
    // A span for the first minute lands late; the next pass rewrites it.
    const late = [...early, req(m + 50_000, { service, failed: true, status: 500 })];
    rollUp(getDb(), late, m - HOUR, now + SETTLE_MS);
    rollUp(getDb(), late, m - HOUR, now + SETTLE_MS);
    assert.deepEqual(minutesOf(service), [
      { route: "/api/products/[id]", minute: m, total: 2, failed: 1, ok_500: 1 },
      { route: "/api/products/[id]", minute: m + MINUTE, total: 1, failed: 0, ok_500: 1 },
    ]);
  });

  it("leaves the minutes from before the telemetry starts as they were", () => {
    const service = "svc-gap";
    const m = t("2026-11-01T12:00:00.000Z");
    const now = m + 10 * MINUTE;
    // Counted while the telemetry still held it.
    rollUp(getDb(), [req(m + 1_000, { service }), req(m + 2 * MINUTE + 1_000, { service })], m - HOUR, now, HOUR);
    // After a restart the telemetry starts partway through minute 2, so
    // minutes 0 to 2 can't be counted again.
    const written = rollUp(getDb(), [req(m + 2 * MINUTE + 40_000, { service })], m + 2 * MINUTE + 30_000, now, HOUR);
    assert.equal(written?.from, m + 3 * MINUTE);
    assert.deepEqual(
      minutesOf(service).map((r) => [r.minute, r.total]),
      [
        [m, 1],
        [m + 2 * MINUTE, 1],
      ],
    );
  });

  it("writes nothing when no minute has settled since the telemetry started", () => {
    const m = t("2026-11-01T13:00:00.000Z");
    assert.equal(rollUp(getDb(), [], m, m + MINUTE + 10_000), undefined);
  });
});

describe("pruneRollups", () => {
  it("summarises complete hours, then drops old minutes by whole hours and old summaries", () => {
    const service = "svc-prune";
    const db = getDb();
    const h = t("2026-06-01T00:00:00.000Z");
    const insertMinute = db.prepare(
      "INSERT INTO request_minutes (service, route, method, minute, total, failed, ok_100, ok_250, ok_500, ok_1000, ok_2500) VALUES (?, '/a', 'GET', ?, ?, ?, 0, 0, ?, 0, 0)",
    );
    const insertHour = db.prepare(
      "INSERT INTO request_hourly (service, route, method, hour, total, failed, ok_100, ok_250, ok_500, ok_1000, ok_2500) VALUES (?, '/a', 'GET', ?, 1, 0, 0, 0, 1, 0, 0)",
    );
    // Two minutes in hour 0, one in hour 1, one in the hour still open.
    insertMinute.run(service, h + 5 * MINUTE, 10, 1, 8);
    insertMinute.run(service, h + 6 * MINUTE, 10, 0, 9);
    insertMinute.run(service, h + HOUR + 1 * MINUTE, 4, 4, 0);
    const now = h + MINUTE_DAYS * 24 * HOUR + HOUR + 30 * MINUTE;
    insertMinute.run(service, now - MINUTE, 3, 0, 3);
    // A summary past 90 days.
    insertHour.run(service, h - 100 * 24 * HOUR);

    pruneRollups(db, now);

    const hours = db
      .prepare("SELECT hour, total, failed, ok_500 FROM request_hourly WHERE service = ? ORDER BY hour")
      .all(service)
      .map((r) => ({ ...r }));
    assert.deepEqual(hours, [
      { hour: h, total: 20, failed: 1, ok_500: 17 },
      { hour: h + HOUR, total: 4, failed: 4, ok_500: 0 },
    ]);
    // Hour 0 is past the minutes' MINUTE_DAYS, hour 1 isn't yet.
    assert.deepEqual(
      minutesOf(service).map((r) => r.minute),
      [h + HOUR + MINUTE, now - MINUTE],
    );
  });
});

describe("countsIn", () => {
  it("adds the hourly summaries older than the minutes kept to the minutes", () => {
    const service = "svc-counts";
    const db = getDb();
    const h = t("2026-07-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO request_hourly (service, route, method, hour, total, failed, ok_100, ok_250, ok_500, ok_1000, ok_2500) VALUES (?, '/a', 'GET', ?, 100, 10, 50, 60, 80, 85, 90)",
    ).run(service, h);
    // Another method on the same route counts too; another route doesn't.
    db.prepare(
      "INSERT INTO request_hourly (service, route, method, hour, total, failed, ok_100, ok_250, ok_500, ok_1000, ok_2500) VALUES (?, '/a', 'POST', ?, 10, 0, 10, 10, 10, 10, 10)",
    ).run(service, h + HOUR);
    db.prepare(
      "INSERT INTO request_hourly (service, route, method, hour, total, failed, ok_100, ok_250, ok_500, ok_1000, ok_2500) VALUES (?, '/b', 'GET', ?, 7, 7, 0, 0, 0, 0, 0)",
    ).run(service, h);
    // The minutes start in hour 2. Its hourly summary is left out, so
    // nothing is counted twice.
    db.prepare(
      "INSERT INTO request_hourly (service, route, method, hour, total, failed, ok_100, ok_250, ok_500, ok_1000, ok_2500) VALUES (?, '/a', 'GET', ?, 999, 0, 0, 0, 0, 0, 0)",
    ).run(service, h + 2 * HOUR);
    rollUp(
      db,
      [
        req(h + 2 * HOUR + 10 * MINUTE, { service, route: "/a", durationMs: 300 }),
        req(h + 2 * HOUR + 11 * MINUTE, { service, route: "/a", failed: true, status: 503 }),
      ],
      h + 2 * HOUR,
      h + 3 * HOUR,
      HOUR,
    );

    const window = { service, route: "/a", from: h, to: h + 3 * HOUR };
    assert.deepEqual(countsIn(window), { total: 112, good: 101 });
    assert.deepEqual(countsIn({ ...window, latencyMs: 250 }), { total: 112, good: 70 });
    assert.deepEqual(countsIn({ ...window, latencyMs: 500 }), { total: 112, good: 91 });
    // Only the minutes.
    assert.deepEqual(countsIn({ ...window, from: h + 2 * HOUR + 11 * MINUTE }), { total: 1, good: 0 });
    // An hour that ends after `to` can't be split, so it's left out.
    assert.deepEqual(countsIn({ ...window, to: h + HOUR + 30 * MINUTE }), { total: 100, good: 90 });
    assert.deepEqual(countsIn({ ...window, route: "/none" }), { total: 0, good: 0 });
  });

  it("refuses a latency that isn't a bucket", () => {
    assert.throws(
      () => countsIn({ service: "svc-counts", route: "/a", from: 0, to: 1, latencyMs: 300 as 250 }),
      /not a latency bucket: 300/,
    );
  });
});

describe("routesSince", () => {
  it("lists each route once, with the method of its latest request", () => {
    const service = "svc-routes";
    const m = t("2026-11-01T14:00:00.000Z");
    rollUp(
      getDb(),
      [
        req(m + 1_000, { service, route: "/api/cart", method: "GET" }),
        req(m + MINUTE + 1_000, { service, route: "/api/cart", method: "POST" }),
        req(m + 2_000, { service, route: "/api/products" }),
      ],
      m - HOUR,
      m + 10 * MINUTE,
      HOUR,
    );
    assert.deepEqual(routesSince(service, m), [
      { route: "/api/cart", method: "POST" },
      { route: "/api/products", method: "GET" },
    ]);
    assert.deepEqual(routesSince(service, m + 2 * MINUTE), []);
  });
});
