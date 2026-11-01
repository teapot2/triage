import { modelLabel } from "../../models/labels";
import { formatCost, incidentUsage } from "../cost";
import type { Incident } from "../schema";
import { grade } from "./grade";
import type { Expected } from "./scenario-source";

// Scoring for scripts/benchmark.ts: each run graded against its scenario's
// ground truth, then rolled up per model into the numbers the write-up
// quotes. Pure, so the report can be rebuilt from saved results.

export type BenchmarkVerdict = "root_cause" | "healthy" | "inconclusive" | "failed";

export interface BenchmarkResult {
  scenario: string;
  // A control scenario has no root cause; a root_cause verdict on it is a
  // false positive.
  control: boolean;
  model: string;
  incidentId: string;
  verdict: BenchmarkVerdict;
  hit: boolean;
  // Why it missed, or what matched (grade.ts).
  reasons: string[];
  // From the run's start to its verdict, retries included.
  seconds?: number;
  cost?: number;
}

export function scoreRun(incident: Incident, scenario: string, expected: Expected): BenchmarkResult {
  const run = incident.run;
  const base = {
    scenario,
    control: expected.verdict === "no_root_cause",
    model: run ? modelLabel(run.model, run.provider, run.reasoningEffort) : "unknown",
    incidentId: incident.id,
    seconds:
      run?.finishedAt && incident.report ? (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000 : undefined,
    cost: incidentUsage(incident)?.cost,
  };
  if (!incident.report) {
    return { ...base, verdict: "failed", hit: false, reasons: [run?.error ?? "no accepted report"] };
  }
  const { hit, reasons } = grade(incident.report, incident.mitigation, expected, incident.evidence);
  return { ...base, verdict: incident.report.verdict.kind, hit, reasons };
}

export interface Rate {
  count: number;
  of: number;
}

export interface ScenarioRow {
  scenario: string;
  control: boolean;
  runs: number;
  hits: number;
  verdicts: Partial<Record<BenchmarkVerdict, number>>;
  medianSeconds?: number;
  medianCost?: number;
}

export interface ModelSummary {
  model: string;
  // Fault scenarios: runs that found the root cause.
  rootCause: Rate;
  // Control scenarios: runs that named a root cause anyway.
  falsePositives: Rate;
  // Fault scenarios' runs that reached a verdict.
  medianSeconds?: number;
  medianCost?: number;
  failed: number;
  scenarios: ScenarioRow[];
}

export function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// The 95% Wilson score interval: honest at 10 runs, where count/of alone
// reads as more certain than it is.
export function wilson({ count, of }: Rate, z = 1.96): [number, number] {
  if (!of) return [0, 1];
  const p = count / of;
  const denom = 1 + (z * z) / of;
  const centre = (p + (z * z) / (2 * of)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / of + (z * z) / (4 * of * of))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

const defined = (xs: (number | undefined)[]) => xs.filter((x): x is number => x !== undefined);

// Models and scenarios in the order their first result came in.
export function summarize(results: BenchmarkResult[]): ModelSummary[] {
  const byModel = Map.groupBy(results, (r) => r.model);
  return [...byModel].map(([model, runs]) => {
    const faults = runs.filter((r) => !r.control);
    const controls = runs.filter((r) => r.control);
    const scenarios = [...Map.groupBy(runs, (r) => r.scenario)].map(([scenario, rs]): ScenarioRow => {
      const verdicts: ScenarioRow["verdicts"] = {};
      for (const r of rs) verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
      return {
        scenario,
        control: rs[0].control,
        runs: rs.length,
        hits: rs.filter((r) => r.hit).length,
        verdicts,
        medianSeconds: median(defined(rs.map((r) => r.seconds))),
        medianCost: median(defined(rs.map((r) => r.cost))),
      };
    });
    return {
      model,
      rootCause: { count: faults.filter((r) => r.hit).length, of: faults.length },
      falsePositives: { count: controls.filter((r) => r.verdict === "root_cause").length, of: controls.length },
      medianSeconds: median(defined(faults.map((r) => r.seconds))),
      medianCost: median(defined(runs.map((r) => r.cost))),
      failed: runs.filter((r) => r.verdict === "failed").length,
      scenarios,
    };
  });
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

// "17/20 (85%, 64–95%)", or "–" when nothing was run.
export function formatRate(rate: Rate): string {
  if (!rate.of) return "–";
  const [lo, hi] = wilson(rate);
  return `${rate.count}/${rate.of} (${pct(rate.count / rate.of)}, ${Math.round(lo * 100)}–${pct(hi)})`;
}

const seconds = (s: number | undefined) => (s === undefined ? "–" : `${Math.round(s)} s`);
const cost = (usd: number | undefined) => (usd === undefined ? "–" : formatCost(usd));

const verdictWords: Record<BenchmarkVerdict, string> = {
  root_cause: "root cause",
  healthy: "healthy",
  inconclusive: "inconclusive",
  failed: "failed",
};

export function benchmarkMarkdown(results: BenchmarkResult[], meta: { date: string; runs: number }): string {
  const summaries = summarize(results);
  const scenarioIds = [...new Set(results.map((r) => r.scenario))];
  const lines = [
    "# Triage benchmark",
    "",
    `${meta.date}. ${meta.runs} run${meta.runs === 1 ? "" : "s"} per scenario and model on the recorded scenarios (${scenarioIds.join(", ")}), investigation only. Rates show the 95% Wilson interval.`,
    "",
    "| Model | Root cause found | False positives (control) | Median time to diagnosis | Median cost per run | Failed runs |",
    "| --- | --- | --- | --- | --- | --- |",
    ...summaries.map(
      (s) =>
        `| ${s.model} | ${formatRate(s.rootCause)} | ${formatRate(s.falsePositives)} | ${seconds(s.medianSeconds)} | ${cost(s.medianCost)} | ${s.failed} |`,
    ),
    "",
    "## By scenario",
    "",
    "| Model | Scenario | Correct | Verdicts | Median time | Median cost |",
    "| --- | --- | --- | --- | --- | --- |",
    ...summaries.flatMap((s) =>
      s.scenarios.map((row) => {
        const verdicts = (Object.keys(verdictWords) as BenchmarkVerdict[])
          .filter((v) => row.verdicts[v])
          .map((v) => `${row.verdicts[v]} ${verdictWords[v]}`)
          .join(", ");
        const scenario = row.control ? `${row.scenario} (control)` : row.scenario;
        return `| ${s.model} | ${scenario} | ${row.hits}/${row.runs} | ${verdicts} | ${seconds(row.medianSeconds)} | ${cost(row.medianCost)} |`;
      }),
    ),
  ];
  const misses = results.filter((r) => !r.hit);
  if (misses.length) {
    lines.push("", "## Misses", "");
    for (const r of misses) lines.push(`- ${r.model}, ${r.scenario} (${r.incidentId}): ${r.reasons.join("; ")}`);
  }
  return `${lines.join("\n")}\n`;
}
