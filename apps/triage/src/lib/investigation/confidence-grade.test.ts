import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ConfidenceGrade, gradeHypothesis, gradeLabels, gradeTone, regressionProven } from "./confidence-grade";
import { incidentBlock } from "./context";
import { fanoutIncident } from "./fanout-fixture";
import { exampleIncidents } from "./fixtures";
import { mitigated } from "./postmortem/test-incidents";
import type { Hypothesis, Incident } from "./schema";

const example = (id: string): Incident => structuredClone(exampleIncidents.find((i) => i.id === id)!);
const poolLeak = () => example("inc_pool_leak");
const priceGap = () => example("inc_price_gap");

const hypothesis = (incident: Incident, id: string): Hypothesis => incident.report!.hypotheses.find((h) => h.id === id)!;
const gradeOf = (incident: Incident, id: string): ConfidenceGrade => gradeHypothesis(hypothesis(incident, id), incident).grade;

// A hypothesis added to the incident's report, its chain citing the given
// evidence IDs (symptom, propagation, root cause).
function withHypothesis(incident: Incident, chain: [string[], string[], string[]], patch: Partial<Hypothesis> = {}): Hypothesis {
  const [symptom, propagation, rootCause] = chain;
  const h: Hypothesis = {
    id: "h_extra",
    title: "Something else",
    confidence: 0.2,
    status: "plausible",
    causalChain: {
      symptom: { text: "The symptom.", evidenceIds: symptom },
      propagation: { text: "How it spread.", evidenceIds: propagation },
      rootCause: { text: "The cause.", evidenceIds: rootCause },
    },
    ...patch,
  };
  incident.report!.hypotheses.push(h);
  return h;
}

// The sandbox runs and fix taken away: nothing has proven the fix.
function unproven(incident: Incident): Incident {
  return { ...incident, fix: undefined, validation: undefined, fixRun: undefined };
}

describe("gradeHypothesis on the bundled examples", () => {
  it("grades the pool leak validated with every alternative ruled out, and the rejected ones contradicted", () => {
    const i = poolLeak();
    const { grade, reason } = gradeHypothesis(hypothesis(i, "h_pool_leak"), i);
    assert.equal(grade, "validated_exclusive");
    assert.match(reason, /^Cited by .*the source.*; the regression test failed before the fix and passes with it; every alternative was ruled out\.$/);
    for (const id of ["h_slow_query", "h_traffic", "h_lock_contention"]) assert.equal(gradeOf(i, id), "contradicted", id);
  });

  it("grades the price gap validated, not exclusive: it had no alternatives to rule out", () => {
    assert.equal(gradeOf(priceGap(), "h_price_gap"), "validated");
  });

  it("grades the fan-out pool leak like the plain one, its evidence relabelled by lane", () => {
    assert.equal(gradeOf(fanoutIncident, "h_pool_leak"), "validated_exclusive");
    assert.equal(gradeOf(fanoutIncident, "h_slow_query"), "contradicted");
  });

  it("has nothing to grade on the control run", () => {
    assert.deepEqual(example("inc_control").report!.hypotheses, []);
  });
});

describe("gradeHypothesis rules", () => {
  it("contradicted: rejected, saying whether the rejection cites evidence the record has", () => {
    const i = poolLeak();
    const h = hypothesis(i, "h_traffic");
    assert.deepEqual(gradeHypothesis(h, i), { grade: "contradicted", reason: "Ruled out on the evidence it cites." });
    // Its chain cites a runtime signal, but a ruled-out row never reads as supported.
    h.rejectedBecause = { text: "Traffic was flat.", evidenceIds: ["ev_not_recorded"] };
    assert.deepEqual(gradeHypothesis(h, i), { grade: "contradicted", reason: "Ruled out by the report; its reason cites no evidence." });
    h.rejectedBecause = undefined;
    assert.equal(gradeHypothesis(h, i).grade, "contradicted");
  });

  it("contradicted: its fan-out lane refuted it, matched by title, even when the lead kept it plausible", () => {
    const i = structuredClone(fanoutIncident);
    const h = hypothesis(i, "h_slow_query");
    h.status = "plausible";
    h.rejectedBecause = undefined;
    assert.deepEqual(gradeHypothesis(h, i), { grade: "contradicted", reason: "Its fan-out lane refuted it." });
  });

  it("speculation: nothing cited beyond the alert's own metric, or nothing the record has", () => {
    const i = poolLeak();
    const alertOnly = withHypothesis(i, [["ev_metric_p95"], ["ev_metric_p95"], ["ev_metric_p95"]]);
    assert.deepEqual(gradeHypothesis(alertOnly, i), { grade: "speculation", reason: "Cites nothing beyond the alert's own metric." });
    const nothing = withHypothesis(i, [["ev_ghost"], ["ev_ghost"], ["ev_ghost"]], { id: "h_nothing" });
    assert.equal(gradeHypothesis(nothing, i).grade, "speculation");
  });

  it("pattern match: the root cause rests on source or history alone", () => {
    const i = poolLeak();
    const h = withHypothesis(i, [["ev_metric_p95"], ["ev_source_stock"], ["ev_commit_stock", "ev_source_stock"]]);
    assert.equal(gradeHypothesis(h, i).grade, "pattern_match");
  });

  it("pattern match: runtime signals with no source or change to explain them", () => {
    const i = poolLeak();
    const h = withHypothesis(i, [["ev_metric_p95"], ["ev_metric_pool"], ["ev_db_activity"]]);
    assert.equal(gradeHypothesis(h, i).grade, "pattern_match");
  });

  it("validated: proof upgrades a pattern match, the recovery or the test being the runtime signal it lacked", () => {
    const i = poolLeak();
    const leading = hypothesis(i, "h_pool_leak");
    leading.causalChain.propagation = { text: "The early return skips the release.", evidenceIds: ["ev_source_stock"] };
    leading.causalChain.rootCause = { text: "The flag put it on the request path.", evidenceIds: ["ev_source_stock", "ev_commit_flag"] };
    assert.equal(gradeHypothesis(leading, unproven(i)).grade, "pattern_match");
    assert.deepEqual(gradeHypothesis(leading, i), {
      grade: "validated_exclusive",
      reason: "The source and a change fit it; the regression test failed before the fix and passes with it; every alternative was ruled out.",
    });
    const recovered = unproven(mitigated());
    const chain = hypothesis(recovered, "h_pool_leak");
    chain.causalChain = { ...leading.causalChain, rootCause: { text: "The early return skips the release.", evidenceIds: ["ev_source_stock"] } };
    assert.deepEqual(gradeHypothesis(chain, recovered), {
      grade: "validated_exclusive",
      reason: "The source fits it; the mitigation recovered the metric; every alternative was ruled out.",
    });
  });

  it("supported: a runtime signal in the cause and source or history in the chain", () => {
    const i = unproven(poolLeak());
    const { grade, reason } = gradeHypothesis(hypothesis(i, "h_pool_leak"), i);
    assert.equal(grade, "supported");
    assert.equal(reason, "Cited by a metric, a database check, a trace, a log, the source and a change.");
  });

  it("supported: runtime signals alone when its fan-out lane found it supported", () => {
    const i = structuredClone(fanoutIncident);
    const h = hypothesis(i, "h_traffic");
    h.status = "plausible";
    h.rejectedBecause = undefined;
    assert.equal(gradeHypothesis(h, i).grade, "pattern_match", "its lane found it unclear");
    i.run!.fanout!.hypotheses.find((l) => l.id === "h3")!.finding = "supported";
    assert.deepEqual(gradeHypothesis(h, i), { grade: "supported", reason: "Its fan-out lane found it supported." });
  });

  it("supported: runtime signals alone for an uptime check, which has no source to cite", () => {
    const i = unproven(priceGap());
    const h = withHypothesis(i, [["ev_metric_errors"], ["ev_log_price"], ["ev_db_missing_prices"]]);
    assert.equal(gradeHypothesis(h, i).grade, "pattern_match");
    i.uptime = { checkId: "chk_1", rule: "down", failedChecks: 3 };
    assert.equal(gradeHypothesis(h, i).grade, "supported");
  });

  it("caps a plausible hypothesis at supported, however proven the fix", () => {
    const i = poolLeak();
    const leading = hypothesis(i, "h_pool_leak");
    const h = withHypothesis(i, [
      leading.causalChain.symptom.evidenceIds,
      leading.causalChain.propagation.evidenceIds,
      leading.causalChain.rootCause.evidenceIds,
    ]);
    assert.equal(gradeHypothesis(h, i).grade, "supported");
  });

  it("validated: a recovered mitigation bears the verdict out without a fix", () => {
    const i = unproven(mitigated());
    const { grade, reason } = gradeHypothesis(hypothesis(i, "h_pool_leak"), i);
    assert.equal(grade, "validated_exclusive");
    assert.match(reason, /; the mitigation recovered the metric; every alternative was ruled out\.$/);
  });

  it("validated, not exclusive, while an alternative is still possible", () => {
    const i = poolLeak();
    const traffic = hypothesis(i, "h_traffic");
    traffic.status = "plausible";
    traffic.rejectedBecause = undefined;
    assert.equal(gradeOf(i, "h_pool_leak"), "validated");
  });

  it("stays supported when the fix stage didn't prove the fix, or the test never failed", () => {
    const failed = poolLeak();
    failed.fixRun = { status: "failed", attempt: 3, startedAt: "2026-10-23T02:15:00Z" };
    assert.equal(regressionProven(failed), false);
    assert.equal(gradeOf(failed, "h_pool_leak"), "supported");
    const passing = poolLeak();
    passing.validation = passing.validation!.map((r) => ({ ...r, exitCode: 0, tests: r.tests.map((t) => ({ ...t, status: "passed" as const })) }));
    assert.equal(gradeOf(passing, "h_pool_leak"), "supported");
  });
});

describe("incidentBlock", () => {
  it("puts the grade beside the model's confidence, for Ask and the postmortem writer", () => {
    const block = incidentBlock(poolLeak(), undefined);
    assert.ok(block.includes("Hypothesis h_pool_leak (leading, confidence 0.86, validated, alternatives ruled out): Connection leak"));
    assert.ok(block.includes("Hypothesis h_traffic (rejected, confidence 0.05, contradicted): Traffic spike"));
  });
});

describe("labels and tones", () => {
  it("names and colours every grade", () => {
    assert.equal(gradeLabels.supported, "Supported by evidence");
    assert.equal(gradeLabels.validated_exclusive, "Validated, alternatives ruled out");
    assert.equal(gradeTone.pattern_match, "warning");
    assert.equal(gradeTone.validated, "success");
    assert.equal(Object.keys(gradeLabels).length, Object.keys(gradeTone).length);
  });
});

describe("gradeHypothesis on a dependency incident", () => {
  // The exposure stage's shape: the advisory as web evidence from the
  // dependency audit, the importing line as source evidence.
  it("counts the dependency audit as a runtime signal beside the source", () => {
    const i = unproven(poolLeak());
    i.evidence.push(
      { id: "ev_web_9", tool: "dependency_audit", kind: "web", summary: "GHSA-c2qf-rxjj-qqgw", url: "https://github.com/advisories/GHSA-c2qf-rxjj-qqgw" },
      { id: "ev_source_9", tool: "grep_source", kind: "source", summary: "runtime.ts:1", file: "src/lib/runtime.ts", startLine: 1, code: 'import semver from "semver";' },
    );
    const h = withHypothesis(i, [["ev_web_9"], ["ev_source_9"], ["ev_web_9"]]);
    assert.deepEqual(gradeHypothesis(h, i), { grade: "supported", reason: "Cited by the dependency audit and the source." });
  });

  it("leaves a web page someone searched as no runtime signal", () => {
    const i = unproven(poolLeak());
    i.evidence.push({ id: "ev_web_9", tool: "web_search", kind: "web", summary: "a blog", url: "https://example.com/" });
    const h = withHypothesis(i, [["ev_web_9"], ["ev_web_9"], ["ev_web_9"]]);
    assert.equal(gradeHypothesis(h, i).grade, "speculation");
  });
});
