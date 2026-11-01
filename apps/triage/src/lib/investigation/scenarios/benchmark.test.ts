import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exampleIncidents } from "../fixtures";
import type { Incident } from "../schema";
import { type BenchmarkResult, benchmarkMarkdown, formatRate, median, scoreRun, summarize, wilson } from "./benchmark";
import { healthy } from "./healthy";
import { poolLeak } from "./pool-leak";

const [poolLeakRun, controlRun] = exampleIncidents;

const result = (r: Partial<BenchmarkResult>): BenchmarkResult => ({
  scenario: "pool-leak",
  control: false,
  model: "spark",
  incidentId: "inc_x",
  verdict: "root_cause",
  hit: true,
  reasons: [],
  ...r,
});

describe("scoreRun", () => {
  it("grades the bundled pool-leak run as a hit, with its time", () => {
    const run = { ...poolLeakRun.run!, startedAt: "2026-10-31T10:00:00.000Z", finishedAt: "2026-10-31T10:01:05.500Z" };
    const r = scoreRun({ ...poolLeakRun, run }, "pool-leak", poolLeak.expected!);
    assert.equal(r.verdict, "root_cause");
    assert.equal(r.hit, true, r.reasons.join("; "));
    assert.equal(r.control, false);
    assert.equal(r.seconds, 65.5);
  });

  it("grades the bundled control run as a hit on the control scenario", () => {
    const r = scoreRun(controlRun, "healthy", healthy.expected!);
    assert.equal(r.verdict, "healthy");
    assert.equal(r.hit, true);
    assert.equal(r.control, true);
  });

  it("counts a run without a report as failed, with the run's error, and no time", () => {
    const failed: Incident = {
      ...poolLeakRun,
      report: undefined,
      run: { ...poolLeakRun.run!, error: "No accepted report after 30 model steps" },
    };
    const r = scoreRun(failed, "pool-leak", poolLeak.expected!);
    assert.deepEqual([r.verdict, r.hit, r.reasons, r.seconds], ["failed", false, ["No accepted report after 30 model steps"], undefined]);
  });
});

describe("median", () => {
  it("takes the middle value, or the mean of the middle two", () => {
    assert.equal(median([]), undefined);
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
  });
});

describe("wilson", () => {
  it("is wide at 10 runs and never leaves 0 to 1", () => {
    const [lo, hi] = wilson({ count: 10, of: 10 });
    assert.equal(hi, 1);
    assert.ok(lo > 0.69 && lo < 0.73, String(lo));
    assert.deepEqual(wilson({ count: 0, of: 0 }), [0, 1]);
    assert.equal(wilson({ count: 0, of: 10 })[0], 0);
  });

  it("formats a rate with its interval", () => {
    assert.equal(formatRate({ count: 8, of: 10 }), "8/10 (80%, 49–94%)");
    assert.equal(formatRate({ count: 0, of: 0 }), "–");
  });
});

describe("summarize", () => {
  const results = [
    result({ seconds: 40, cost: 0.1 }),
    result({ hit: false, verdict: "inconclusive", seconds: 80, cost: 0.2 }),
    result({ scenario: "price-gap", seconds: 60, cost: 0.3 }),
    result({ scenario: "price-gap", hit: false, verdict: "failed", reasons: ["timed out"], cost: 0.4 }),
    result({ scenario: "healthy", control: true, verdict: "healthy", seconds: 20, cost: 0.05 }),
    result({ scenario: "healthy", control: true, verdict: "root_cause", hit: false, seconds: 30, cost: 0.06 }),
    result({ model: "glimmer", seconds: 50, cost: 0.02 }),
  ];
  const [spark, glimmer] = summarize(results);

  it("counts root causes on fault scenarios and false positives on the control", () => {
    assert.equal(spark.model, "spark");
    assert.deepEqual(spark.rootCause, { count: 2, of: 4 });
    assert.deepEqual(spark.falsePositives, { count: 1, of: 2 });
    assert.equal(spark.failed, 1);
    assert.deepEqual(glimmer.falsePositives, { count: 0, of: 0 });
  });

  it("takes the median time over fault runs that reached a verdict, and cost over every run", () => {
    assert.equal(spark.medianSeconds, 60);
    assert.ok(Math.abs(spark.medianCost! - 0.15) < 1e-9, String(spark.medianCost));
  });

  it("breaks each model down by scenario, in the order they came in", () => {
    assert.deepEqual(
      spark.scenarios.map((s) => [s.scenario, s.control, s.hits, s.runs, s.verdicts]),
      [
        ["pool-leak", false, 1, 2, { root_cause: 1, inconclusive: 1 }],
        ["price-gap", false, 1, 2, { root_cause: 1, failed: 1 }],
        ["healthy", true, 1, 2, { healthy: 1, root_cause: 1 }],
      ],
    );
  });

  it("writes the headline table, the breakdown and each miss with its reasons", () => {
    const md = benchmarkMarkdown(results, { date: "2026-10-31", runs: 2 });
    assert.match(md, /^# Triage benchmark/);
    assert.match(md, /2 runs per scenario and model on the recorded scenarios \(pool-leak, price-gap, healthy\)/);
    assert.match(md, /\| spark \| 2\/4 \(50%, 15–85%\) \| 1\/2 \(50%, 9–91%\) \| 60 s \| \$0\.15 \| 1 \|/);
    assert.match(md, /\| glimmer \| 1\/1 \(100%, 21–100%\) \| – \| 50 s \| \$0\.02 \| 0 \|/);
    assert.match(md, /\| spark \| healthy \(control\) \| 1\/2 \| 1 root cause, 1 healthy \|/);
    assert.match(md, /- spark, price-gap \(inc_x\): timed out/);
  });
});
