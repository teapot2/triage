import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Hypothesis, type InvestigationReport, reportProblems } from "./schema";

const claim = (text: string) => ({ text, evidenceIds: ["ev_metric_1"] });

function hypothesis(id: string, title: string, rootCause: string, status: Hypothesis["status"]): Hypothesis {
  return {
    id,
    title,
    confidence: status === "leading" ? 0.7 : 0.15,
    status,
    causalChain: { symptom: claim("p95 over its limit"), propagation: claim("requests wait"), rootCause: claim(rootCause) },
    rejectedBecause: status === "rejected" ? claim("contradicted by the traces") : undefined,
  };
}

// A root_cause report whose leading hypothesis is h1.
function report(leading: Hypothesis): InvestigationReport {
  return {
    summary: "What happened.",
    hypotheses: [
      leading,
      hypothesis("h2", "Slow dependency", "The database answered slowly", "plausible"),
      hypothesis("h3", "Pool leak", "Connections are not released", "rejected"),
    ],
    verdict: { kind: "root_cause", hypothesisId: leading.id },
    servicesQueried: ["shopfront", "postgres"],
  };
}

const nothingWrong = (r: InvestigationReport) => reportProblems(r).filter((p) => p.includes("says nothing is wrong"));

describe("reportProblems", () => {
  it("sends back a root cause that says nothing is wrong, as on the Glimmer run", () => {
    const r = report(
      hypothesis(
        "h1_idle_false_positive",
        "No ongoing latency problem; alert is false positive due to idle traffic",
        "Service is idle with no traffic after a brief burst; the metric is meaningless without samples.",
        "leading",
      ),
    );
    assert.equal(nothingWrong(r).length, 1);
    assert.match(nothingWrong(r)[0], /submit healthy/);
  });

  it("checks the root cause's text as well as the title", () => {
    const r = report(hypothesis("h1", "Latency alert", "There is no real issue: one request was slow.", "leading"));
    assert.equal(nothingWrong(r).length, 1);
  });

  it("accepts a fault in the system", () => {
    const r = report(
      hypothesis(
        "h1",
        "Pooled client leak in getStockLevelDirect",
        "The missing-row path returns without releasing its client, so the pool runs out.",
        "leading",
      ),
    );
    assert.deepEqual(reportProblems(r), []);
  });

  it("doesn't mistake a transient fault or a recovery for no fault", () => {
    const r = report(
      hypothesis(
        "h1",
        "Transient database failover dropped connections",
        "Postgres failed over at 19:02; requests errored until the pool reconnected and latency recovered.",
        "leading",
      ),
    );
    assert.deepEqual(nothingWrong(r), []);
  });

  it("sends back placeholder hypotheses, as on the Spark run", () => {
    const stub = (n: number, status: Hypothesis["status"]): Hypothesis => ({
      id: `h${n}`,
      title: `t${n}`,
      confidence: status === "leading" ? 0.86 : 0.07,
      status,
      causalChain: { symptom: claim(`s${n}`), propagation: claim(`p${n}`), rootCause: claim(`r${n}`) },
      rejectedBecause: status === "rejected" ? claim(`rej${n}`) : undefined,
    });
    const r: InvestigationReport = {
      summary: "Enabling the flag crashed the product API for items without price rows.",
      hypotheses: [stub(1, "leading"), stub(2, "rejected"), stub(3, "rejected")],
      verdict: { kind: "root_cause", hypothesisId: "h1" },
      servicesQueried: ["shopfront"],
    };
    const problems = reportProblems(r).filter((p) => p.includes("placeholders"));
    assert.equal(problems.length, 3);
    assert.match(problems[0], /title "t1", symptom "s1", propagation "p1", rootCause "r1"/);
    assert.match(problems[1], /rejectedBecause "rej2"/);
  });

  it("sends back a one-word or empty claim", () => {
    const h = hypothesis("h1", "Price lookup throws", "missing", "leading");
    h.causalChain.symptom = claim("  ");
    const [problem] = reportProblems(report(h));
    assert.match(problem, /symptom "  ", rootCause "missing"/);
  });

  it("accepts short real titles and two-word claims", () => {
    const r = report(hypothesis("h1", "Leak", "Connections leak", "leading"));
    assert.deepEqual(reportProblems(r), []);
  });

  it("leaves healthy verdicts alone", () => {
    const r: InvestigationReport = {
      summary: "Nothing is wrong.",
      hypotheses: [],
      verdict: { kind: "healthy", rationale: claim("A false positive: one slow request while the route compiled.") },
      servicesQueried: ["shopfront"],
    };
    assert.deepEqual(reportProblems(r), []);
  });
});
