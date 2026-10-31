import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatUptime, uptimeOver, type HourCounts, type UptimeFigure } from "./history";
import type { UptimeSample } from "./model";

// Twenty past noon, so the current hour is partial: a 24 h window runs from
// 13:00 yesterday to now.
const HOUR = 3_600_000;
const noon = Date.parse("2026-10-30T12:00:00.000Z");
const now = noon + 20 * 60_000;

// The summary of the hour starting `h` hours from noon (negative is earlier).
const summary = (h: number, checks: number, down: number): HourCounts => ({
  hour: new Date(noon + h * HOUR).toISOString(),
  checks,
  down,
});

// A raw result `min` minutes from noon.
const sample = (min: number, outcome: UptimeSample["outcome"]): UptimeSample => ({
  at: new Date(noon + min * 60_000).toISOString(),
  ms: outcome === "down" ? 15_000 : 184,
  ...(outcome === "down" ? { error: "timeout after 15000 ms" } : { status: 200 }),
  outcome,
});

const figure = (checks: number, down: number): UptimeFigure => ({ percent: ((checks - down) / checks) * 100, checks, down, hours: 24 });

describe("uptimeOver", () => {
  it("counts summaries alone", () => {
    const hourly = [summary(-3, 120, 0), summary(-2, 120, 6), summary(-1, 120, 0)];
    assert.deepEqual(uptimeOver(hourly, [], now, 24), { percent: (354 / 360) * 100, checks: 360, down: 6, hours: 24 });
  });

  it("counts raw samples alone", () => {
    const raw = [sample(-90, "ok"), sample(-30, "down"), sample(5, "ok"), sample(10, "ok")];
    assert.deepEqual(uptimeOver([], raw, now, 24), { percent: 75, checks: 4, down: 1, hours: 24 });
  });

  it("lets an hour's summary win over its raw samples, counting it once", () => {
    // 11:00 has a summary and raw samples; 12:00 has only raw ones.
    const hourly = [summary(-1, 120, 2)];
    const raw = [sample(-50, "down"), sample(-40, "down"), sample(-10, "ok"), sample(5, "ok"), sample(15, "down")];
    assert.deepEqual(uptimeOver(hourly, raw, now, 24), { percent: (119 / 122) * 100, checks: 122, down: 3, hours: 24 });
  });

  it("ignores the hour just before the window", () => {
    // 24 h back from noon is 12:00 yesterday: one hour too early. 13:00 counts.
    const hourly = [summary(-24, 100, 100), summary(-23, 100, 0)];
    const raw = [sample(-24 * 60 + 59, "down")];
    assert.deepEqual(uptimeOver(hourly, raw, now, 24), { percent: 100, checks: 100, down: 0, hours: 24 });
  });

  it("counts the current, partial hour from its raw samples", () => {
    const raw = [sample(0, "ok"), sample(19, "down")];
    assert.deepEqual(uptimeOver([], raw, now, 1), { percent: 50, checks: 2, down: 1, hours: 1 });
    // A one-hour window doesn't reach back past noon.
    assert.equal(uptimeOver([summary(-1, 120, 0)], [], now, 1), undefined);
  });

  it("ignores samples after now", () => {
    const raw = [sample(10, "ok"), sample(20, "ok"), sample(21, "down"), sample(90, "down")];
    assert.deepEqual(uptimeOver([], raw, now, 24), { percent: 100, checks: 2, down: 0, hours: 24 });
  });

  it("is undefined with no checks in the window", () => {
    assert.equal(uptimeOver([], [], now, 24), undefined);
    assert.equal(uptimeOver([summary(-30, 120, 0)], [sample(-48 * 60, "ok")], now, 24), undefined);
    // A summary for an hour nothing was checked in is still no checks.
    assert.equal(uptimeOver([summary(-2, 0, 0)], [], now, 24), undefined);
  });

  it("counts slow as up", () => {
    const raw = [sample(1, "slow"), sample(2, "slow"), sample(3, "ok"), sample(4, "down")];
    assert.deepEqual(uptimeOver([], raw, now, 24), { percent: 75, checks: 4, down: 1, hours: 24 });
  });

  it("takes the stored hourly rollups as they are", () => {
    type HourlyRollup = { hour: string; checks: number; ok: number; slow: number; down: number; avgMs: number; maxMs: number };
    const rollups: HourlyRollup[] = [{ hour: summary(-1, 0, 0).hour, checks: 120, ok: 100, slow: 19, down: 1, avgMs: 300, maxMs: 15_000 }];
    assert.deepEqual(uptimeOver(rollups, [], now, 24), { percent: (119 / 120) * 100, checks: 120, down: 1, hours: 24 });
  });

  it("reaches back 30 days at the widest", () => {
    const hourly = [summary(-30 * 24 + 1, 120, 120), summary(-30 * 24, 120, 120)];
    assert.deepEqual(uptimeOver(hourly, [], now, 30 * 24), { percent: 0, checks: 120, down: 120, hours: 720 });
  });
});

describe("formatUptime", () => {
  it("shows 100% only with nothing down", () => {
    assert.equal(formatUptime(figure(100_000, 0)), "100%");
  });

  it("never rounds a down result up to 100%", () => {
    assert.equal(formatUptime(figure(100_000, 1)), "99.99%");
    assert.equal(formatUptime(figure(10_000_000, 1)), "99.99%");
  });

  it("floors to two decimals", () => {
    assert.equal(formatUptime(figure(100_000, 4)), "99.99%"); // 99.996
    assert.equal(formatUptime(figure(10_000, 5)), "99.95%");
    assert.equal(formatUptime(figure(3, 1)), "66.66%");
  });

  it("always shows two decimals", () => {
    assert.equal(formatUptime(figure(1000, 1)), "99.90%");
    assert.equal(formatUptime(figure(2, 1)), "50.00%");
    assert.equal(formatUptime(figure(4, 4)), "0.00%");
  });
});
