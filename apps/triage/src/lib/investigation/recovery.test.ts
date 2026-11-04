import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { closeDb } from "../db";
import { exampleIncidents } from "./fixtures";
import { liveReader, pastThreshold, perMinute } from "./recovery";
import type { Incident, MetricPoint } from "./schema";
import { saveChecks } from "./uptime/checks";
import { defaultCheck } from "./uptime/model";
import { appendSample } from "./uptime/samples";
import { availabilityMetric, responseTimeMetric } from "./uptime/source";
import { judgeWindow } from "./verify";

// The uptime case reads .data from the working directory: a temp one.
const cwd = process.cwd();
let dir: string;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "triage-recovery-"));
  process.chdir(dir);
});
after(async () => {
  // Windows won't delete the temp directory while the database is open.
  closeDb();
  process.chdir(cwd);
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

const MINUTE = 60_000;

const withSource = (source: string | undefined, patch: Partial<Incident["trigger"]> = {}): Incident => {
  const base = structuredClone(exampleIncidents[0]);
  return {
    ...base,
    trigger: { ...base.trigger, ...patch },
    run: source === undefined ? undefined : { source, model: "muse-spark-1.3", startedAt: base.detectedAt },
  };
};

describe("pastThreshold", () => {
  it("is at or over the limit, or under it where less is worse", () => {
    const latency = pastThreshold("http.server.duration p95", 500);
    assert.deepEqual([latency(499), latency(500), latency(900)], [false, true, true]);
    const availability = pastThreshold("uptime.availability{check=chk_abc123}", 100);
    assert.deepEqual([availability(100), availability(99.9), availability(0)], [false, true, true]);
  });

  it("is over the limit, not at it, for a rule's 'more than N' count or share of slow requests", () => {
    const count = pastThreshold("http.server.slow_requests{route=/,le=1500}", 3);
    assert.deepEqual([count(0), count(3), count(4)], [false, false, true]);
    const share = pastThreshold("http.server.slow_share{route=/,le=1500}", 10);
    assert.deepEqual([share(10), share(10.01), share(50)], [false, true, true]);
  });
});

describe("perMinute", () => {
  const at = (iso: string, value: number): MetricPoint => ({ t: `2026-11-03T10:${iso}.000Z`, value });

  it("keeps each minute's worst value, at the minute's start", () => {
    const points = [at("00:05", 120), at("00:35", 2400), at("01:05", 90), at("01:35", 110)];
    assert.deepEqual(perMinute(points, "uptime.response_time{check=chk_abc123}"), [at("00:00", 2400), at("01:00", 110)]);
    assert.deepEqual(perMinute(points, "uptime.availability{check=chk_abc123}"), [at("00:00", 120), at("01:00", 90)]);
  });

  it("leaves a per-minute series as it was", () => {
    const points = [at("00:00", 140), at("01:00", 121)];
    assert.deepEqual(perMinute(points, "http.server.duration p95"), points);
  });
});

describe("liveReader", () => {
  it("has nothing live for recorded runs, so those alone are replayed", () => {
    for (const incident of exampleIncidents) assert.equal(liveReader(incident), undefined);
    assert.equal(liveReader(withSource("scenario:pool-leak")), undefined);
    assert.equal(liveReader(withSource("demo")), undefined);
    assert.ok(liveReader(withSource("live:shopfront")));
  });

  // The bug: an open Down incident's Verify replayed a quiet value padded
  // from the trigger's series, and resolved whatever the endpoint did.
  it("reads an uptime check's own results now, so an outage never verifies", async () => {
    const check = defaultCheck({ id: "chk_down01", name: "Example", url: "https://example.com/" });
    await saveChecks([check]);
    const now = Date.now();
    const thisMinute = Math.floor(now / MINUTE) * MINUTE;
    // Down for the last five completed minutes, two checks a minute.
    for (let m = 5; m >= 1; m--) {
      for (const s of [5, 35]) {
        await appendSample(check.id, {
          at: new Date(thisMinute - m * MINUTE + s * 1000).toISOString(),
          ms: 15_000,
          outcome: "down",
          error: "ECONNREFUSED",
        });
      }
    }
    const metric = availabilityMetric(check);
    const incident = withSource(`uptime:${check.id}`, { metric, threshold: 100, route: check.url });
    const read = liveReader(incident);
    assert.ok(read, "an uptime incident is watched, not replayed");

    const since = thisMinute - 6 * MINUTE;
    const series = (await read(metric, 10)).filter((p) => Date.parse(p.t) > since && Date.parse(p.t) < thisMinute);
    assert.deepEqual(series.map((p) => p.value), [0, 0, 0, 0, 0]);
    assert.deepEqual(judgeWindow(series, 100, 5, metric), { kind: "breached", at: series[0].t, value: 0 });

    // The Slow chart's response time, one point per minute at its slowest.
    const slow = await read(responseTimeMetric(check), 10);
    assert.ok(slow.length >= 5 && slow.every((p) => p.value === 15_000));
  });
});
