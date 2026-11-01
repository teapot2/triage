import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fanoutIncident } from "./fanout-fixture";
import { exampleIncidents } from "./fixtures";
import { type Signal, rollupLabels, rollupOf, rollupTone, verdictOutcome } from "./outcome";
import { mitigated, poolLeak, reopened, resolved } from "./postmortem/test-incidents";
import type { Incident } from "./schema";

const example = (id: string): Incident => structuredClone(exampleIncidents.find((i) => i.id === id)!);
const unproven = (incident: Incident): Incident => ({ ...incident, fix: undefined, validation: undefined, fixRun: undefined, approval: undefined });
const brief = (signals: Signal[]) => signals.map((s) => `${s.kind}:${s.status}`);

describe("verdictOutcome on the bundled examples", () => {
  it("has no outcome for the control run: nothing was diagnosed", () => {
    assert.equal(verdictOutcome(example("inc_control")), undefined);
  });

  it("confirms the pool leak on its regression test, failed before the fix and passing with it", () => {
    const outcome = verdictOutcome(example("inc_pool_leak"))!;
    assert.deepEqual(outcome.hypothesis, {
      id: "h_pool_leak",
      title: "Connection leak in getStockLevel exhausts the pg pool",
      confidence: 0.86,
      grade: "validated_exclusive",
    });
    assert.equal(outcome.rollup, "confirmed");
    assert.deepEqual(brief(outcome.signals), ["fix:confirmed"]);
    assert.match(outcome.signals[0].text, /^The regression test "releases the client when the stock row is missing" failed on the original code/);
  });

  it("confirms the price gap the same way", () => {
    const outcome = verdictOutcome(example("inc_price_gap"))!;
    assert.equal(outcome.hypothesis.grade, "validated");
    assert.equal(outcome.rollup, "confirmed");
    assert.deepEqual(brief(outcome.signals), ["fix:confirmed"]);
  });
});

describe("verdictOutcome roll-ups", () => {
  it("unverified: nothing has checked it yet (a proposed mitigation is no check)", () => {
    const outcome = verdictOutcome(unproven(example("inc_pool_leak")))!;
    assert.equal(outcome.rollup, "unverified");
    assert.deepEqual(outcome.signals, []);
  });

  it("confirmed: the mitigation recovered the metric, the test proved the fix and the quiet window held", () => {
    const outcome = verdictOutcome(resolved())!;
    assert.equal(outcome.rollup, "confirmed");
    assert.deepEqual(brief(outcome.signals), ["fix:confirmed", "mitigation:confirmed", "verification:confirmed"]);
    const recovery = outcome.signals.find((s) => s.kind === "mitigation")!;
    assert.equal(recovery.text, "Turning off FF_STOCK_DIRECT_QUERY brought p95 latency back under 500 ms");
    assert.equal(recovery.at, "2026-10-23T02:18:00.000Z");
  });

  it("held with caveats: resolved, then reopened by the watch", () => {
    const outcome = verdictOutcome(reopened())!;
    assert.equal(outcome.rollup, "held_with_caveats");
    assert.deepEqual(outcome.signals.at(-1), {
      kind: "reopening",
      status: "contradicted",
      at: "2026-10-23T02:30:00.000Z",
      text: "Reopened by Triage's watch: p95 latency back over 500 ms",
    });
  });

  it("confirmed: a reviewer denied a fix with feedback, then the test proved the retry", () => {
    const i = poolLeak();
    i.fixAttempts = [
      {
        fix: i.fix!,
        validation: i.validation,
        fixRun: { ...i.fixRun!, finishedAt: "2026-10-23T02:15:00.000Z" },
        approval: { state: "denied", requestedAt: "2026-10-23T02:15:10.000Z", decidedAt: "2026-10-23T02:15:30.000Z", decidedBy: "Dana", reason: "Release in finally, not per branch" },
      },
    ];
    const outcome = verdictOutcome(i)!;
    // The deny asked for a better fix, not a different diagnosis.
    assert.equal(outcome.rollup, "confirmed");
    assert.deepEqual(brief(outcome.signals), ["human:unknown", "fix:confirmed"]);
    assert.equal(outcome.signals[0].text, "A reviewer denied fix 1: Release in finally, not per branch");
    assert.ok(!outcome.signals[0].text.includes("Dana"), "blameless: who decided is never named");
  });

  it("contradicted: the mitigation applied and the metric never came back", () => {
    const i = unproven(mitigated());
    i.mitigation!.recovery = { ...i.mitigation!.recovery!, status: "not_recovered", recoveredAt: undefined, checkedAt: "2026-10-23T02:25:00.000Z", note: "still at 2900 ms" };
    const outcome = verdictOutcome(i)!;
    assert.equal(outcome.rollup, "contradicted");
    assert.deepEqual(outcome.signals, [
      {
        kind: "mitigation",
        status: "contradicted",
        at: "2026-10-23T02:25:00.000Z",
        text: "Turning off FF_STOCK_DIRECT_QUERY did not bring p95 latency back under 500 ms: still at 2900 ms",
      },
    ]);
  });

  it("contradicted: the fix stage found no code defect to fix", () => {
    const i = unproven(example("inc_pool_leak"));
    i.fixRun = { status: "declined", declinedBecause: "The pool is simply too small for the traffic.", attempt: 1, startedAt: "2026-10-23T02:15:00Z", finishedAt: "2026-10-23T02:16:00Z" };
    const outcome = verdictOutcome(i)!;
    assert.equal(outcome.rollup, "contradicted");
    assert.deepEqual(brief(outcome.signals), ["fix:contradicted"]);
  });

  it("contradicted: the quiet window after the fix was breached", () => {
    const i = resolved();
    i.mitigation = undefined;
    i.fix = undefined;
    i.fixRun = undefined;
    i.verification = { ...i.verification!, after: "fix", status: "breached", breachedAt: "2026-10-23T02:21:00.000Z", breachValue: 640 };
    const outcome = verdictOutcome(i)!;
    assert.equal(outcome.rollup, "contradicted");
    assert.equal(outcome.signals[0].text, "p95 latency went back over 500 ms (640 ms) in the quiet window after the fix");
  });

  it("leaves a denied current fix unknown", () => {
    const i = poolLeak();
    i.approval = { ...i.approval!, state: "denied", decidedAt: "2026-10-23T02:17:00.000Z", reason: "Use a fake timer in the test" };
    const outcome = verdictOutcome(i)!;
    assert.deepEqual(brief(outcome.signals), ["fix:confirmed", "human:unknown"]);
    assert.equal(outcome.signals[1].text, "A reviewer denied the fix: Use a fake timer in the test");
    assert.equal(outcome.rollup, "confirmed");
  });

  it("leaves a person's decisions unknown: a denied mitigation, a manual verification, a reopening by hand", () => {
    const i = unproven(mitigated());
    i.mitigation = { ...i.mitigation!, state: "denied", recovery: undefined, appliedAt: undefined };
    i.verification = { ...resolved().verification!, after: "manual" };
    i.reopenings = [{ at: "2026-10-23T02:40:00.000Z", by: "person", why: "Customers still see errors" }];
    const outcome = verdictOutcome(i)!;
    assert.equal(outcome.rollup, "unverified");
    assert.deepEqual(brief(outcome.signals), ["human:unknown", "human:unknown", "human:unknown"]);
  });

  it("keeps a leading hypothesis an inconclusive verdict still named", () => {
    const i = example("inc_pool_leak");
    i.report!.verdict = { kind: "inconclusive", missing: ["application logs"] };
    assert.equal(verdictOutcome(i)?.hypothesis.id, "h_pool_leak");
    i.report!.hypotheses = i.report!.hypotheses.filter((h) => h.status !== "leading");
    assert.equal(verdictOutcome(i), undefined);
  });
});

describe("verdictOutcome with a fan-out", () => {
  // The fan-out pool leak with the lead's hypothesis matched to lane h1.
  function fanout(finding: "supported" | "refuted" | "unclear", proven: boolean): Incident {
    const i = structuredClone(fanoutIncident);
    const lane = i.run!.fanout!.hypotheses.find((h) => h.id === "h1")!;
    lane.title = "Connection leak in getStockLevel exhausts the pg pool";
    lane.finding = finding;
    return proven ? i : unproven(i);
  }

  it("notes the lane agreeing, which alone confirms nothing: a lane is Triage too", () => {
    const outcome = verdictOutcome(fanout("supported", false))!;
    assert.deepEqual(outcome.signals.map((s) => [s.kind, s.status, s.text]), [["fanout", "confirmed", "Its lane found it supported"]]);
    assert.equal(outcome.rollup, "unverified");
  });

  it("holds with caveats when the lead chose it although its lane refuted it, and the fix proved it", () => {
    const outcome = verdictOutcome(fanout("refuted", true))!;
    assert.equal(outcome.rollup, "held_with_caveats");
    assert.ok(outcome.signals.some((s) => s.kind === "fanout" && s.status === "contradicted" && s.text === "The lead chose it although its lane found it refuted"));
    // A lane that refuted the lead's own hypothesis contradicts it.
    assert.equal(outcome.hypothesis.grade, "contradicted");
  });

  it("leaves an unclear lane unknown", () => {
    const outcome = verdictOutcome(fanout("unclear", false))!;
    assert.deepEqual(brief(outcome.signals), ["fanout:unknown"]);
    assert.equal(outcome.rollup, "unverified");
  });
});

describe("rollupOf", () => {
  const signal = (kind: Signal["kind"], status: Signal["status"]): Signal => ({ kind, status, text: "" });

  it("weighs only the checks for confirmation, and every signal as a caveat", () => {
    assert.equal(rollupOf([]), "unverified");
    assert.equal(rollupOf([signal("human", "contradicted")]), "unverified");
    assert.equal(rollupOf([signal("fanout", "contradicted")]), "unverified");
    assert.equal(rollupOf([signal("verification", "contradicted")]), "contradicted");
    assert.equal(rollupOf([signal("verification", "confirmed")]), "confirmed");
    assert.equal(rollupOf([signal("reopening", "contradicted"), signal("verification", "confirmed")]), "held_with_caveats");
    assert.equal(rollupOf([signal("fanout", "contradicted"), signal("fix", "confirmed")]), "held_with_caveats");
    assert.equal(rollupOf([signal("human", "unknown"), signal("mitigation", "confirmed")]), "confirmed");
  });

  it("has a label and tone for every roll-up", () => {
    assert.deepEqual(Object.keys(rollupLabels).sort(), Object.keys(rollupTone).sort());
    assert.equal(rollupLabels.held_with_caveats, "Held with caveats");
  });
});
