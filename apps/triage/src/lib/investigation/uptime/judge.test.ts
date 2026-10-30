import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { judgeCheck } from "./judge";
import { defaultCheck, type UptimeSample } from "./model";

// Defaults: Slow after 3 slow checks, Down after 5 min, 30 s apart.
const check = defaultCheck({ id: "chk_abc123", name: "Google", url: "https://www.google.com" });
const t0 = Date.parse("2026-10-30T12:00:00.000Z");
const at = (i: number) => new Date(t0 + i * 30_000).toISOString();

const ok = (i: number, ms = 184): UptimeSample => ({ at: at(i), ms, status: 200, outcome: "ok" });
const slow = (i: number): UptimeSample => ({ at: at(i), ms: 12_000, status: 200, outcome: "slow" });
const timeout = (i: number): UptimeSample => ({ at: at(i), ms: 15_000, outcome: "down", error: "timeout after 15000 ms" });
const bad = (i: number): UptimeSample => ({ at: at(i), ms: 40, status: 503, outcome: "down", error: "HTTP 503" });

// Builds samples from a string, one character per check: o ok, s slow, t
// timeout, d HTTP 503. Returns them with the time of the last.
function run(pattern: string) {
  const make = { o: ok, s: slow, t: timeout, d: bad } as const;
  const samples = [...pattern].map((c, i) => make[c as keyof typeof make](i));
  return { samples, now: t0 + (pattern.length - 1) * 30_000 };
}

describe("judgeCheck", () => {
  it("has nothing to say before the first check", () => {
    assert.deepEqual(judgeCheck(check, [], t0), { status: "unchecked", slowStreak: 0, healthyStreak: 0, summary: "not checked yet" });
  });

  it("reads healthy with the last answer", () => {
    const { samples, now } = run("ooo");
    const j = judgeCheck(check, samples, now);
    assert.equal(j.status, "healthy");
    assert.equal(j.summary, "200 in 184 ms");
    assert.equal(j.trip, undefined);
  });

  it("opens Slow on the third slow sample, not the second", () => {
    const second = run("oss");
    assert.equal(judgeCheck(check, second.samples, second.now).trip, undefined);
    assert.equal(judgeCheck(check, second.samples, second.now).summary, "slow, check 2 of 3");
    const third = run("osss");
    const j = judgeCheck(check, third.samples, third.now);
    assert.equal(j.status, "slow");
    assert.equal(j.slowStreak, 3);
    assert.equal(j.trip, "slow");
    assert.equal(j.summary, "slow, check 3 of 3");
  });

  it("opens Down once the run of down samples reaches the window, not before", () => {
    // Ten 30 s checks span 4.5 min; the eleventh is at 5 min.
    const before = run(`o${"d".repeat(10)}`);
    const jb = judgeCheck(check, before.samples, before.now);
    assert.equal(jb.status, "unavailable");
    assert.equal(jb.downSince, at(1));
    assert.equal(jb.trip, undefined);
    assert.equal(jb.summary, "down 4 of 5 min");

    const reached = run(`o${"d".repeat(11)}`);
    const jr = judgeCheck(check, reached.samples, reached.now);
    assert.equal(jr.trip, "down");
    assert.equal(jr.summary, "down 5 min");
  });

  it("starts the down window over after an acceptable answer", () => {
    const { samples, now } = run(`${"d".repeat(8)}o${"d".repeat(4)}`);
    const j = judgeCheck(check, samples, now);
    assert.equal(j.downSince, at(9));
    assert.equal(j.trip, undefined);
  });

  it("keeps a timeout out of the slow streak", () => {
    const { samples, now } = run("sstss");
    const j = judgeCheck(check, samples, now);
    assert.equal(j.slowStreak, 2);
    assert.equal(j.trip, undefined);
    // Nor do timeouts alone make a slow streak.
    const timeouts = run("ttt");
    assert.equal(judgeCheck(check, timeouts.samples, timeouts.now).slowStreak, 0);
    assert.equal(judgeCheck(check, timeouts.samples, timeouts.now).trip, undefined);
  });

  it("prefers Down when a slow episode turns into an outage", () => {
    // Slow long enough to trip, then down for the whole window.
    const { samples, now } = run(`ssss${"t".repeat(11)}`);
    const j = judgeCheck(check, samples, now);
    assert.equal(j.trip, "down");
    assert.equal(j.status, "unavailable");
  });

  it("trips Down on a one-check window as soon as it has lasted a minute", () => {
    const quick = { ...check, downMinutesToOpen: 1 };
    const { samples, now } = run("oddd");
    assert.equal(judgeCheck(quick, samples, now).trip, "down");
    assert.equal(judgeCheck(quick, samples.slice(0, 3), now - 30_000).trip, undefined);
  });

  it("counts healthy samples in a row for recovery", () => {
    const { samples, now } = run("dddddoo");
    assert.equal(judgeCheck(check, samples, now).healthyStreak, 2);
    const more = run("dddddooo");
    const j = judgeCheck(check, more.samples, more.now);
    assert.equal(j.healthyStreak, 3);
    assert.ok(j.healthyStreak >= check.healthyChecksToRecover);
    assert.equal(j.downSince, undefined);
    // A slow answer is in range but doesn't count toward recovery.
    const slowed = run("dddddoos");
    assert.equal(judgeCheck(check, slowed.samples, slowed.now).healthyStreak, 0);
  });

  it("ignores samples after now", () => {
    const { samples } = run("ooosss");
    const j = judgeCheck(check, samples, t0 + 2 * 30_000);
    assert.equal(j.status, "healthy");
    assert.equal(j.healthyStreak, 3);
  });
});
