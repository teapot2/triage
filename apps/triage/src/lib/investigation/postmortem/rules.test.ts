import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exampleIncidents } from "../fixtures";
import type { Incident } from "../schema";
import {
  blamelessProblems,
  citedEvidenceIds,
  nextPostmortem,
  type PostmortemSubmission,
  postmortemProblems,
  postmortemRefusal,
} from "./rules";

// The pool leak has a report, a fix and a pending approval; the control
// run is healthy.
const poolLeak = (): Incident => structuredClone(exampleIncidents.find((i) => i.id === "inc_pool_leak")!);
const control = (): Incident => structuredClone(exampleIncidents.find((i) => i.id === "inc_control")!);

function submission(patch: Partial<PostmortemSubmission> = {}): PostmortemSubmission {
  return {
    summary:
      "Product pages timed out for eleven minutes after a deploy. A missing stock row leaked a pooled connection on every request. Turning the flag off stopped it.",
    impact: { text: "Product page requests waited 3 s and failed with 500s.", evidenceIds: ["ev_metric_p95", "ev_log_timeout"] },
    contributingFactors: [
      { text: "getStockLevel returned before releasing its client on a missing row.", evidenceIds: ["ev_source_stock"] },
      { text: "The flag put that path on every product request.", evidenceIds: ["ev_commit_flag", "ev_log_stock_miss"] },
      { text: "The pool holds only 10 connections, so it ran out in minutes.", evidenceIds: ["ev_metric_pool"] },
    ],
    wentWell: [{ text: "The latency alert fired as the pool ran out.", evidenceIds: ["ev_metric_p95"] }],
    wentBadly: [{ text: "Nothing alerted on pool saturation itself.", evidenceIds: ["ev_metric_pool"] }],
    lucky: ["Traffic was flat; a spike would have run the pool out sooner."],
    actionItems: [
      { title: "Alert when the pool stays above 80% in use", kind: "detect_sooner", priority: "P2", evidenceIds: ["ev_metric_pool"] },
      { title: "Lint for pooled clients released outside finally", kind: "prevent_class", priority: "P2" },
    ],
    ...patch,
  };
}

describe("postmortemRefusal", () => {
  it("accepts a diagnosed incident with nothing running", () => {
    assert.equal(postmortemRefusal(poolLeak()), undefined);
  });

  it("refuses an incident without a report, or still investigating", () => {
    assert.match(postmortemRefusal({ ...poolLeak(), report: undefined })!, /no report yet/);
    assert.match(postmortemRefusal({ ...poolLeak(), status: "investigating" })!, /no report yet/);
  });

  it("refuses a healthy run", () => {
    assert.match(postmortemRefusal(control())!, /healthy run has nothing/);
  });

  it("refuses while the postmortem is being written", () => {
    const writing = { ...poolLeak(), postmortem: nextPostmortem({ provider: "meta", model: "muse-spark-1.3" }) };
    assert.match(postmortemRefusal(writing)!, /already being written/);
    const failed = { ...writing, postmortem: { ...writing.postmortem, status: "failed" as const } };
    assert.equal(postmortemRefusal(failed), undefined);
  });

  it("refuses while the fix stage runs", () => {
    const i = poolLeak();
    for (const status of ["writing", "testing"] as const) {
      const fixRun = { status, attempt: 1, startedAt: "2026-10-23T02:15:00Z" };
      assert.match(postmortemRefusal({ ...i, fixRun })!, /wait for the fix stage to finish/);
    }
    assert.equal(postmortemRefusal({ ...i, fixRun: { status: "proven", attempt: 1, startedAt: "2026-10-23T02:15:00Z" } }), undefined);
  });

  it("refuses while the mitigation runs or its recovery is watched", () => {
    const i = poolLeak();
    const m = i.mitigation!;
    for (const state of ["approved", "running"] as const) {
      assert.match(postmortemRefusal({ ...i, mitigation: { ...m, state } })!, /wait for the mitigation to finish/);
    }
    const recovery = { metric: "p95", threshold: 500, since: "2026-10-23T02:15:00Z", series: [], status: "watching" as const };
    assert.match(postmortemRefusal({ ...i, mitigation: { ...m, state: "applied", recovery } })!, /wait for the mitigation/);
    assert.equal(
      postmortemRefusal({ ...i, mitigation: { ...m, state: "applied", recovery: { ...recovery, status: "recovered" } } }),
      undefined,
    );
  });
});

describe("nextPostmortem", () => {
  it("is a writing record with the stage's model", () => {
    assert.deepEqual(nextPostmortem({ provider: "meta", model: "muse-spark-1.3" }, new Date("2026-10-29T10:00:00Z")), {
      status: "writing",
      startedAt: "2026-10-29T10:00:00.000Z",
      provider: "meta",
      model: "muse-spark-1.3",
    });
  });
});

describe("blamelessProblems", () => {
  it("catches the pool-leak commit's author, whole words only, any case", () => {
    const i = poolLeak();
    assert.equal(blamelessProblems("Sebastian shipped a1b9c4e.", i).length, 1);
    assert.match(blamelessProblems("Sebastian shipped a1b9c4e.", i)[0], /"sebastian"/);
    assert.deepEqual(blamelessProblems("A deploy shipped a1b9c4e.", i), []);
    assert.deepEqual(blamelessProblems("sebastians", i), []);
  });

  it("ignores unknown authors", () => {
    assert.deepEqual(blamelessProblems("The flag's author is unknown.", poolLeak()), []);
  });

  it("catches whoever decided an approval, here or on a denied attempt", () => {
    const i = poolLeak();
    i.approval = { ...i.approval!, decidedBy: "Ada Lovelace <ada@example.dev>" };
    assert.match(blamelessProblems("Lovelace approved it.", i)[0], /"lovelace"/);
    assert.deepEqual(blamelessProblems("example dev", i), []);
  });

  it("catches blaming phrases, one problem each, but not 'blameless'", () => {
    const i = poolLeak();
    assert.match(blamelessProblems("The deploy should have been tested.", i)[0], /"should have"/);
    assert.equal(blamelessProblems("Careless review; it failed to release. Blame the fault of the deploy.", i).length, 4);
    assert.deepEqual(blamelessProblems("This blameless postmortem covers it.", i), []);
  });
});

describe("postmortemProblems", () => {
  it("accepts a good submission", () => {
    assert.deepEqual(postmortemProblems(submission(), poolLeak()), []);
  });

  it("lists an unknown ID", () => {
    const s = submission({ wentWell: [{ text: "Alert fired.", evidenceIds: ["ev_metric_p95", "ev_log_made_up"] }] });
    assert.deepEqual(postmortemProblems(s, poolLeak()), [
      "unknown evidence IDs cited: ev_log_made_up. Cite only IDs listed in the prompt",
    ]);
  });

  it("accepts IDs from a question's evidence", () => {
    const i = poolLeak();
    i.questions = [
      {
        id: "q_1",
        text: "Why?",
        askedAt: "2026-10-23T03:00:00Z",
        status: "answered",
        answer: "",
        citedIds: [],
        unknownIds: [],
        steps: [],
        evidence: [{ ...i.evidence[0], id: "ev_q1_metric_1" }],
        mode: "tools",
        model: "muse-spark-1.3",
      },
    ];
    const s = submission({ wentWell: [{ text: "Alert fired.", evidenceIds: ["ev_q1_metric_1"] }] });
    assert.deepEqual(postmortemProblems(s, i), []);
  });

  it("wants 2 to 5 contributing factors", () => {
    const factor = submission().contributingFactors[0];
    assert.match(postmortemProblems(submission({ contributingFactors: Array(6).fill(factor) }), poolLeak())[0], /has 6: give 2 to 5/);
    assert.match(postmortemProblems(submission({ contributingFactors: [factor] }), poolLeak())[0], /has 1: give 2 to 5/);
  });

  it("checks every text field for names and blame", () => {
    const s = submission({
      lucky: ["sebastian was awake."],
      actionItems: [{ title: "Engineers should have tested the missing-row path", kind: "prevent_class", priority: "P2" }],
    });
    assert.deepEqual(
      postmortemProblems(s, poolLeak()).map((p) => p.split(" ")[0]),
      ["lucky[0]", "actionItems[0].title"],
    );
  });

  it("rejects an action item that repeats the fix", () => {
    const i = poolLeak();
    for (const title of ["Merge the PR", "Approve the fix", "Release the pooled client in a finally block"]) {
      const s = submission({ actionItems: [{ title, kind: "fix_this", priority: "P1" }] });
      assert.match(postmortemProblems(s, i)[0], /repeats the fix/);
    }
  });

  it("rejects evidence IDs in the summary", () => {
    const s = submission({ summary: "Pages timed out [ev_metric_p95]." });
    assert.match(postmortemProblems(s, poolLeak())[0], /summary cites evidence IDs/);
  });
});

describe("citedEvidenceIds", () => {
  it("lists every cited ID once, in order of first mention", () => {
    assert.deepEqual(citedEvidenceIds(submission()), [
      "ev_metric_p95",
      "ev_log_timeout",
      "ev_source_stock",
      "ev_commit_flag",
      "ev_log_stock_miss",
      "ev_metric_pool",
    ]);
  });
});
