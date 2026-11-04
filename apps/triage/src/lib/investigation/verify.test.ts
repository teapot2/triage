import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exampleIncidents } from "./fixtures";
import type { Incident, MetricPoint, Verification } from "./schema";
import { judgeWindow, reopened, resolved, resolveRefusal, simulatedWindow, verificationRefusal } from "./verify";

// Points a minute apart from 10:00, one per value.
const minutes = (...values: number[]): MetricPoint[] =>
  values.map((value, i) => ({ t: new Date(Date.parse("2026-10-29T10:00:00.000Z") + i * 60_000).toISOString(), value }));

// The pool-leak example (a report, a fix and a pending approval).
const example = (patch: Partial<Incident> = {}): Incident => ({
  ...structuredClone(exampleIncidents.find((i) => i.fix && i.approval)!),
  ...patch,
});

const verifying: Verification = {
  after: "mitigation",
  since: "2026-10-29T10:00:00.000Z",
  windowMinutes: 5,
  metric: "http.server.duration p95",
  threshold: 500,
  series: [],
  status: "verifying",
  startedAt: "2026-10-29T10:01:00.000Z",
};

describe("judgeWindow", () => {
  it("resolves once the window's minutes are all under the threshold, at the last one", () => {
    assert.deepEqual(judgeWindow(minutes(140, 121, 130, 118, 125), 500, 5), {
      kind: "resolved",
      at: "2026-10-29T10:04:00.000Z",
    });
  });

  it("breaches on the first minute at or over the threshold", () => {
    assert.deepEqual(judgeWindow(minutes(140, 500, 900), 500, 5), {
      kind: "breached",
      at: "2026-10-29T10:01:00.000Z",
      value: 500,
    });
    // Even once the window is full.
    assert.equal(judgeWindow(minutes(140, 121, 130, 118, 125, 610), 500, 5).kind, "breached");
  });

  it("keeps verifying with too few minutes", () => {
    assert.deepEqual(judgeWindow(minutes(140, 121), 500, 5), { kind: "verifying", quiet: 2 });
    assert.deepEqual(judgeWindow([], 500, 5), { kind: "verifying", quiet: 0 });
  });

  it("neither counts nor breaks on an idle minute", () => {
    const [a, b, , c, d, e] = minutes(140, 121, 0, 130, 118, 125);
    // 10:02 had no requests: four minutes so far, then the fifth resolves.
    assert.deepEqual(judgeWindow([a, b, c, d], 500, 5), { kind: "verifying", quiet: 4 });
    assert.deepEqual(judgeWindow([a, b, c, d, e], 500, 5), { kind: "resolved", at: "2026-10-29T10:05:00.000Z" });
  });
});

describe("resolved", () => {
  it("sets the status and the time", () => {
    const after = resolved(example(), "2026-10-29T10:05:00.000Z");
    assert.equal(after.status, "resolved");
    assert.equal(after.resolvedAt, "2026-10-29T10:05:00.000Z");
  });
});

describe("reopened", () => {
  const at = "2026-10-29T10:20:30.000Z";

  it("records the resolution it undid and goes back to awaiting approval with a pending fix", () => {
    const before = resolved(example(), "2026-10-29T10:05:00.000Z");
    const after = reopened(before, { at, by: "person", why: "testing" });
    assert.equal(after.status, "awaiting_approval");
    assert.equal(after.resolvedAt, undefined);
    assert.deepEqual(after.reopenings, [{ at, by: "person", why: "testing", resolvedAt: "2026-10-29T10:05:00.000Z" }]);
  });

  it("goes back to diagnosed without a pending approval", () => {
    const decided = example({ approval: { state: "approved", requestedAt: at, decidedAt: at } });
    assert.equal(reopened(resolved(decided, at), { at, by: "watch", why: "breach" }).status, "diagnosed");
    const none = example({ approval: undefined });
    assert.equal(reopened(resolved(none, at), { at, by: "watch", why: "breach" }).status, "diagnosed");
  });

  it("records a breach on an incident that was never resolved, without a resolvedAt", () => {
    const after = reopened(example(), { at, by: "verification", why: "p95 latency back over 500 ms", value: 880 });
    assert.equal(after.status, "awaiting_approval");
    assert.deepEqual(after.reopenings, [{ at, by: "verification", why: "p95 latency back over 500 ms", value: 880 }]);
  });

  it("ignores a second reopening in the same minute as the last", () => {
    const resolvedOnce = resolved(example(), "2026-10-29T10:05:00.000Z");
    const once = reopened(resolvedOnce, { at, by: "verification", why: "breach", value: 880 });
    const twice = reopened(once, { at: "2026-10-29T10:20:59.000Z", by: "watch", why: "breach" });
    assert.equal(twice, once);
    // The next minute is a new one.
    const later = reopened(once, { at: "2026-10-29T10:21:00.000Z", by: "watch", why: "breach" });
    assert.equal(later.reopenings?.length, 2);
  });

  it("counts a same-minute reopening when the incident was resolved again in between", () => {
    const once = reopened(resolved(example(), "2026-10-29T10:05:00.000Z"), { at, by: "person", why: "a" });
    const again = reopened(resolved(once, "2026-10-29T10:20:40.000Z"), {
      at: "2026-10-29T10:20:50.000Z",
      by: "person",
      why: "b",
    });
    assert.equal(again.reopenings?.length, 2);
    assert.equal(again.reopenings?.[1].resolvedAt, "2026-10-29T10:20:40.000Z");
  });
});

describe("judgeWindow on a metric where less is worse", () => {
  // A Down incident charts availability per minute against 100 %.
  const availability = "uptime.availability{check=chk_abc123}";

  it("resolves on minutes at 100 %", () => {
    assert.deepEqual(judgeWindow(minutes(100, 100, 100, 100, 100), 100, 5, availability), {
      kind: "resolved",
      at: "2026-10-29T10:04:00.000Z",
    });
  });

  it("breaches on the first minute under it, not over it", () => {
    assert.deepEqual(judgeWindow(minutes(100, 50, 0), 100, 5, availability), {
      kind: "breached",
      at: "2026-10-29T10:01:00.000Z",
      value: 50,
    });
    // A down minute is never a quiet one.
    assert.equal(judgeWindow(minutes(0, 0, 0, 0, 0), 100, 5, availability).kind, "breached");
  });
});

describe("verificationRefusal", () => {
  it("refuses before the investigation has a report", () => {
    assert.match(verificationRefusal(example({ status: "investigating" }), "manual")!, /no report/);
    assert.match(verificationRefusal(example({ report: undefined, status: "failed" }), "manual")!, /no report/);
  });

  it("refuses while one is running", () => {
    assert.match(verificationRefusal(example({ verification: verifying }), "manual")!, /already running/);
    const breached = example({ verification: { ...verifying, status: "breached" } });
    assert.equal(verificationRefusal(breached, "mitigation"), undefined);
  });

  it("verifies a resolved incident again only by hand", () => {
    const done = resolved(example(), "2026-10-29T10:05:00.000Z");
    assert.match(verificationRefusal(done, "mitigation")!, /already resolved/);
    assert.match(verificationRefusal(done, "fix")!, /already resolved/);
    assert.equal(verificationRefusal(done, "manual"), undefined);
  });

  it("allows one once there is a report", () => {
    assert.equal(verificationRefusal(example(), "mitigation"), undefined);
    assert.equal(verificationRefusal(example({ status: "diagnosed" }), "fix"), undefined);
  });
});

describe("resolveRefusal", () => {
  it("refuses a resolved incident or one without a report", () => {
    assert.match(resolveRefusal(resolved(example(), "2026-10-29T10:05:00.000Z"))!, /already resolved/);
    assert.match(resolveRefusal(example({ status: "investigating" }))!, /no report/);
    assert.equal(resolveRefusal(example()), undefined);
  });
});

describe("simulatedWindow", () => {
  it("replays the recovery after `since`, then pads with its last quiet value", () => {
    const series = minutes(2910, 1480, 520, 210, 140, 121);
    const recovery = {
      metric: verifying.metric,
      threshold: 500,
      since: series[0].t,
      series,
      status: "recovered" as const,
      recoveredAt: series[3].t,
    };
    const incident = example({ mitigation: { ...example().mitigation!, recovery } });
    assert.deepEqual(
      simulatedWindow(incident, { ...verifying, since: series[3].t }).map((p) => [p.t.slice(11, 16), p.value]),
      [
        ["10:04", 140],
        ["10:05", 121],
        ["10:06", 121],
        ["10:07", 121],
        ["10:08", 121],
      ],
    );
  });

  it("starts after `since` when a manual verify comes after the recovery's last point", () => {
    const series = minutes(2910, 1480, 520, 210, 140, 121);
    const recovery = {
      metric: verifying.metric,
      threshold: 500,
      since: series[0].t,
      series,
      status: "recovered" as const,
      recoveredAt: series[3].t,
    };
    const incident = example({ mitigation: { ...example().mitigation!, recovery } });
    // Verify again at 10:20:30: the window is the quiet value from 10:21 on.
    assert.deepEqual(
      simulatedWindow(incident, { ...verifying, since: "2026-10-29T10:20:30.000Z" }).map((p) => [p.t.slice(11, 16), p.value]),
      [
        ["10:21", 121],
        ["10:22", 121],
        ["10:23", 121],
        ["10:24", 121],
        ["10:25", 121],
      ],
    );
  });

  it("falls back to the trigger's last value under the threshold", () => {
    const incident = example({ mitigation: undefined });
    const quiet = incident.trigger.series.findLast((p) => p.value < 500)!.value;
    const window = simulatedWindow(incident, verifying);
    assert.equal(window.length, 5);
    assert.ok(window.every((p) => p.value === quiet));
    assert.equal(window[0].t, "2026-10-29T10:01:00.000Z");
  });
});

describe("simulatedWindow on a metric where less is worse", () => {
  it("pads with a healthy value, never a down one", () => {
    const metric = "uptime.availability{check=chk_abc123}";
    const base = example({ mitigation: undefined });
    const incident = { ...base, trigger: { ...base.trigger, metric, threshold: 100, series: minutes(100, 100, 0, 0) } };
    const window = simulatedWindow(incident, { ...verifying, threshold: 100 });
    assert.ok(window.every((p) => p.value === 100));
    assert.equal(judgeWindow(window, 100, 5, metric).kind, "resolved");
  });
});

// A slow-request rule's incident is judged on the rule's own measure, per
// minute: "more than 3" breaches at 4, never at 3.
describe("judgeWindow on a count of slow requests", () => {
  const metric = "http.server.slow_requests{route=/,le=1500}";

  it("resolves on minutes at or under the count, a minute with none slow included", () => {
    assert.deepEqual(judgeWindow(minutes(1, 3, 0, 2, 3), 3, 5, metric), { kind: "resolved", at: "2026-10-29T10:04:00.000Z" });
  });

  it("breaches on the first minute with more than the count", () => {
    assert.deepEqual(judgeWindow(minutes(1, 3, 4, 0), 3, 5, metric), { kind: "breached", at: "2026-10-29T10:02:00.000Z", value: 4 });
  });

  it("breaches on any slow request when the rule allows none", () => {
    assert.equal(judgeWindow(minutes(0, 0, 0, 0, 0), 0, 5, metric).kind, "resolved");
    assert.equal(judgeWindow(minutes(0, 1), 0, 5, metric).kind, "breached");
  });
});

describe("judgeWindow on a share of slow requests", () => {
  const metric = "http.server.slow_share{route=/,le=1500}";

  it("resolves at the share and breaches past it", () => {
    assert.equal(judgeWindow(minutes(10, 0, 5, 10, 9.5), 10, 5, metric).kind, "resolved");
    assert.deepEqual(judgeWindow(minutes(10, 10.5), 10, 5, metric), { kind: "breached", at: "2026-10-29T10:01:00.000Z", value: 10.5 });
  });
});

describe("simulatedWindow on a count of slow requests", () => {
  it("pads with a value at or under the count, which the window then resolves on", () => {
    const metric = "http.server.slow_requests{route=/,le=1500}";
    const base = example({ mitigation: undefined });
    const incident = { ...base, trigger: { ...base.trigger, metric, unit: "requests", threshold: 3, series: minutes(0, 3, 9, 12) } };
    const window = simulatedWindow(incident, { ...verifying, threshold: 3 });
    // 3 is the last minute on the healthy side: "more than 3" breaches at 4.
    assert.ok(window.every((p) => p.value === 3));
    assert.equal(judgeWindow(window, 3, 5, metric).kind, "resolved");
  });
});
