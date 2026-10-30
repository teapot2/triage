import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Incident } from "../schema";
import { mitigated, poolLeak, reopened, resolved } from "./test-incidents";
import { durations, firstBreach, postmortemTimeline } from "./timeline";

const at = (minutes: number) => new Date(Date.parse("2026-10-23T02:00:00.000Z") + minutes * 60_000).toISOString();

describe("postmortemTimeline", () => {
  it("is sorted by time", () => {
    for (const incident of [poolLeak(), mitigated(), resolved(), reopened()]) {
      const times = postmortemTimeline(incident).map((e) => Date.parse(e.at));
      assert.deepEqual(times, [...times].sort((a, b) => a - b));
    }
  });

  it("starts at the first breach and names who opened the incident", () => {
    const events = postmortemTimeline(poolLeak());
    assert.deepEqual(events[0], { at: "2026-10-23T02:10:00.000Z", event: "p95 latency crossed 500 ms" });
    assert.ok(events.some((e) => e.event === "Alert fired; incident opened by Triage's watch"));
    const byPerson = postmortemTimeline({ ...poolLeak(), openedBy: undefined });
    assert.ok(byPerson.some((e) => e.event === "Alert fired; incident opened by a person"));
  });

  it("has the verdict, the fix stage and the pending approval", () => {
    const events = postmortemTimeline(poolLeak()).map((e) => e.event);
    assert.ok(events.includes("Investigation started (muse-spark-1.3)"));
    assert.ok(events.includes("Verdict: Connection leak in getStockLevel exhausts the pg pool"));
    assert.ok(events.includes("Fix attempt 1 started"));
    assert.ok(events.includes("Fix attempt 1 proven after 2 submissions"));
    assert.ok(events.includes("Fix awaiting approval"));
    // Proposed by the fixture, but not decided: no decision event.
    assert.ok(events.includes("Mitigation proposed: Turn off FF_STOCK_DIRECT_QUERY"));
    assert.ok(!events.some((e) => e.startsWith("Mitigation approved")));
  });

  it("includes the mitigation's decision, application and recovery", () => {
    const events = postmortemTimeline(mitigated());
    const find = (text: string) => events.find((e) => e.event === text);
    assert.equal(find("Mitigation approved")?.at, "2026-10-23T02:15:00.000Z");
    assert.equal(find("Mitigation applied")?.at, "2026-10-23T02:15:20.000Z");
    assert.equal(find("p95 latency back under 500 ms")?.at, "2026-10-23T02:18:00.000Z");
  });

  it("ends on the resolution, after the verification started", () => {
    const events = postmortemTimeline(resolved());
    assert.ok(
      events.some(
        (e) => e.at === "2026-10-23T02:18:05.000Z" && e.event === "Verification started: watching p95 latency for 5 min",
      ),
    );
    assert.deepEqual(events.at(-1), { at: "2026-10-23T02:23:00.000Z", event: "Incident resolved" });
  });

  it("names who reopened it and why, and drops the undone resolution", () => {
    const events = postmortemTimeline(reopened());
    assert.deepEqual(events.at(-1), {
      at: "2026-10-23T02:30:00.000Z",
      event: "Reopened by Triage's watch: p95 latency back over 500 ms",
    });
    assert.ok(!events.some((e) => e.event === "Incident resolved"));
    const byPerson = reopened();
    byPerson.reopenings![0] = { ...byPerson.reopenings![0], by: "person", why: "errors are back\nsince 02:29" };
    assert.ok(postmortemTimeline(byPerson).some((e) => e.event === "Reopened by a person: errors are back"));
  });

  it("says when the recovery watch gave up", () => {
    const incident = mitigated();
    incident.mitigation!.recovery = {
      ...incident.mitigation!.recovery!,
      status: "not_recovered",
      recoveredAt: undefined,
      checkedAt: at(30),
    };
    const events = postmortemTimeline(incident);
    assert.ok(events.some((e) => e.at === at(30) && e.event === "Recovery watch gave up: still over the threshold"));
    assert.ok(!events.some((e) => e.event.includes("back under")));
  });

  it("numbers denied attempts before the current one and never names who decided", () => {
    const incident = poolLeak();
    incident.fixAttempts = [
      {
        fix: incident.fix!,
        fixRun: { status: "proven", attempt: 1, startedAt: at(11), finishedAt: at(12), model: "m" },
        approval: {
          state: "denied",
          requestedAt: at(12),
          decidedAt: at(13),
          decidedBy: "Dana Reviewer",
          reason: "only release the connection\nand nothing else",
        },
      },
    ];
    incident.approval = {
      state: "approved",
      requestedAt: "2026-10-23T02:16:30.000Z",
      decidedAt: "2026-10-23T02:17:00.000Z",
      decidedBy: "Dana Reviewer",
      prState: "opened",
      prUrl: "https://github.com/acme/shopfront/pull/7",
    };
    const events = postmortemTimeline(incident).map((e) => e.event);
    assert.ok(events.includes("Fix attempt 1 proven after 1 submission"));
    assert.ok(events.includes("Fix attempt 1 denied: only release the connection"));
    assert.ok(events.includes("Fix attempt 2 started"));
    assert.ok(events.includes("Fix approved · draft PR opened"));
    assert.ok(!events.some((e) => e.includes("Dana")));
  });

  it("reads a declined fix stage, a failed run and questions", () => {
    const incident: Incident = {
      ...poolLeak(),
      status: "failed",
      run: { source: "s", model: "m", startedAt: at(14), finishedAt: at(15), error: "model timed out\nstack…" },
      fixRun: { status: "declined", declinedBecause: "not a code defect", attempt: 1, startedAt: at(16), finishedAt: at(17) },
      approval: undefined,
      questions: [
        {
          id: "q_1",
          text: "Why 02:09?",
          askedAt: at(20),
          status: "answered",
          answer: "",
          citedIds: [],
          unknownIds: [],
          steps: [],
          evidence: [],
          mode: "evidence_only",
          model: "m",
        },
      ],
    };
    const events = postmortemTimeline(incident).map((e) => e.event);
    assert.ok(events.includes("Investigation failed: model timed out"));
    assert.ok(events.includes("Fix stage declined: not a code defect"));
    assert.ok(events.includes("Question asked: Why 02:09?"));
  });
});

describe("durations", () => {
  it("measures detect, diagnose, mitigate and recover from hand-set timestamps", () => {
    const incident = mitigated();
    incident.trigger.series = [
      { t: at(0), value: 100 },
      { t: at(1), value: 600 },
      { t: at(2), value: 900 },
    ];
    incident.detectedAt = at(5);
    incident.run!.finishedAt = at(7);
    incident.mitigation!.appliedAt = at(12);
    incident.mitigation!.recovery!.recoveredAt = at(20);
    assert.equal(firstBreach(incident), at(1));
    assert.deepEqual(durations(incident), [
      { label: "Time to detect", ms: 4 * 60_000 },
      { label: "Time to diagnose", ms: 2 * 60_000 },
      { label: "Time to mitigate", ms: 7 * 60_000 },
      { label: "Time to recover", ms: 19 * 60_000 },
    ]);
  });

  it("starts at the episode that fired the alert, not an earlier one in the series", () => {
    // The live run: an earlier episode from 23:46, healthy by 00:00, then
    // breaching again from 00:12; the alert fired at 00:13:47.
    const minute = (hhmm: string) => `2026-10-${hhmm < "12:00" ? "30" : "29"}T${hhmm}:00.000Z`;
    const incident = mitigated();
    const points: [string, number][] = [
      ["23:44", 7], ["23:45", 8], ["23:46", 3000], ["23:50", 3020], ["23:55", 2990],
      ["00:00", 9], ["00:05", 7], ["00:11", 8], ["00:12", 2800], ["00:13", 3019],
    ];
    incident.trigger.series = points.map(([hhmm, value]) => ({ t: minute(hhmm), value }));
    incident.detectedAt = "2026-10-30T00:13:47.000Z";
    incident.run!.finishedAt = "2026-10-30T00:14:39.000Z";
    incident.mitigation!.appliedAt = "2026-10-30T00:15:02.000Z";
    incident.mitigation!.recovery!.recoveredAt = "2026-10-30T00:16:00.000Z";
    assert.equal(firstBreach(incident), minute("00:12"));
    const crossed = postmortemTimeline(incident).filter((e) => e.event === "p95 latency crossed 500 ms");
    assert.deepEqual(crossed, [{ at: minute("00:12"), event: "p95 latency crossed 500 ms" }]);
    const detect = durations(incident).find((d) => d.label === "Time to detect");
    assert.ok(detect && detect.ms < 2 * 60_000, `time to detect ${detect?.ms} ms`);
    assert.equal(durations(incident).find((d) => d.label === "Time to recover")?.ms, 4 * 60_000);
  });

  it("keeps one healthy bucket inside the episode, and falls back to a breach after the alert", () => {
    const incident = mitigated();
    incident.trigger.series = [100, 600, 700, 100, 800, 900].map((value, i) => ({ t: at(i), value }));
    incident.detectedAt = at(5);
    assert.equal(firstBreach(incident), at(1));
    incident.trigger.series[2].value = 100;
    incident.trigger.series[3].value = 100;
    assert.equal(firstBreach(incident), at(4));
    incident.detectedAt = at(0);
    assert.equal(firstBreach(incident), at(1));
  });

  it("measures the time to resolve from the first breach, only while resolved", () => {
    const resolve = (incident: Incident) => durations(incident).find((d) => d.label === "Time to resolve");
    assert.deepEqual(resolve(resolved()), { label: "Time to resolve", ms: 13 * 60_000 });
    assert.equal(resolve(reopened()), undefined);
    assert.equal(resolve(mitigated()), undefined);
  });

  it("leaves out spans with a missing or reversed end", () => {
    const incident = poolLeak();
    incident.trigger.series = incident.trigger.series.map((p) => ({ ...p, value: 0 }));
    incident.run!.finishedAt = "2026-10-23T02:13:00.000Z";
    // No breach, a run that "finished" before detection, no mitigation applied.
    assert.deepEqual(durations(incident), []);
  });
});
