// Runs each recorded scenario several times per model and scores every run
// against the scenario's ground truth: how often the root cause is found,
// how often the control run gets a root cause anyway, and the median time
// and cost to a verdict. Investigation only (no fix stage), and the runs
// stay out of the incident list.
//
//   pnpm --filter @triage/web benchmark
//     10 runs of every scenario on Spark (Meta's API) and Glimmer
//     (OpenRouter), 3 at a time.
//
//   pnpm --filter @triage/web benchmark --runs 3 --models spark@low,spark@high --scenarios pool-leak,healthy
//     A model is an alias (spark, wonder, glimmer, spark-open) or
//     provider:model, with @effort for Meta's reasoning effort (otherwise
//     the Investigate stage's effort in Settings). --concurrency sets how
//     many run at once.
//
//   pnpm --filter @triage/web benchmark --models spark,spark+wonder,glimmer+wonder@max
//     <lanes>+<lead> runs the hypothesis fan-out: the lead model proposes
//     and merges, the lanes' model checks each hypothesis. Each side is a
//     model as above (the lead's effort defaults to the Lead stage's). A
//     plain model runs the single agent, whatever Settings says.
//
//   pnpm --filter @triage/web benchmark --report .data/benchmarks/<stamp>
//     Rebuilds a benchmark's report from the runs it finished, graded
//     again, say after stopping it partway or changing a scenario's
//     ground truth. No model calls.
//
// Needs MODEL_API_KEY (and OPENROUTER_API_KEY for Glimmer) in .env.local.
// Writes .data/benchmarks/<stamp>/: each run's incident under runs/,
// results.ndjson as runs finish, and report.md, which it also prints.

import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { runInvestigation, scenarioIncident } from "../src/lib/investigation/agent";
import { type Scenario, createScenarioSource, getScenario, scenarios } from "../src/lib/investigation/scenarios";
import { type BenchmarkResult, benchmarkMarkdown, scoreRun, splitModelSpec } from "../src/lib/investigation/scenarios/benchmark";
import { formatCost } from "../src/lib/investigation/cost";
import { incidentSchema } from "../src/lib/investigation/schema";
import { providerIdSchema, providers } from "../src/lib/models/providers";
import { type Endpoint, endpointFor, type StageModel, stageModel, stageProblem } from "../src/lib/models/settings";
import { reasoningEffortSchema } from "../src/lib/models/stages";

const aliases: Record<string, string> = {
  spark: `meta:${providers.meta.spark}`,
  wonder: "meta:muse-wonder-1.0",
  glimmer: `openrouter:${providers.openrouter.glimmer}`,
  "spark-open": `openrouter:${providers.openrouter.sparkOpen}`,
};

type Stage = Required<StageModel> & Endpoint;

async function parseModel(spec: string, defaultEffort: Stage["effort"]): Promise<Stage> {
  const [name, effortText] = spec.split("@");
  const full = aliases[name] ?? name;
  const colon = full.indexOf(":");
  const provider = providerIdSchema.safeParse(full.slice(0, colon));
  if (colon < 0 || !provider.success) {
    throw new Error(`"${spec}": expected an alias (${Object.keys(aliases).join(", ")}) or provider:model`);
  }
  const effort = effortText === undefined ? defaultEffort : reasoningEffortSchema.parse(effortText);
  const stage = { provider: provider.data, model: full.slice(colon + 1), effort, ...(await endpointFor(provider.data)) };
  const problem = stageProblem(stage);
  if (problem) throw new Error(`${spec}: ${problem}`);
  return stage;
}

// A model spec: one model for the single agent, or <lanes>+<lead> for a
// fan-out.
async function parseSpec(
  spec: string,
  efforts: { lanes: Stage["effort"]; lead: Stage["effort"] },
): Promise<{ stage: Stage; lead?: Stage }> {
  const { lanes, lead } = splitModelSpec(spec);
  return {
    stage: await parseModel(lanes, efforts.lanes),
    lead: lead === undefined ? undefined : await parseModel(lead, efforts.lead),
  };
}

// Runs `jobs` with at most `limit` at once, in order.
async function pool<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return out;
}

// Every saved run, graded again with the scenarios' ground truth as it is
// now, so a change to the grader or a word list applies to old runs too.
async function regrade(dir: string): Promise<BenchmarkResult[]> {
  const files = (await readdir(path.join(dir, "runs"))).filter((f) => f.endsWith(".json")).sort();
  const results: BenchmarkResult[] = [];
  for (const f of files) {
    const incident = incidentSchema.parse(JSON.parse(await readFile(path.join(dir, "runs", f), "utf8")));
    const scenario = getScenario(incident.run?.source.replace(/^scenario:/, "") ?? "");
    if (scenario?.expected) results.push(scoreRun(incident, scenario.id, scenario.expected));
  }
  // In the order the runs finished, as results.ndjson has them.
  const order = new Map(
    (await readFile(path.join(dir, "results.ndjson"), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line, i) => [(JSON.parse(line) as BenchmarkResult).incidentId, i]),
  );
  return results.sort((a, b) => (order.get(a.incidentId) ?? Infinity) - (order.get(b.incidentId) ?? Infinity));
}

async function writeReport(dir: string, results: BenchmarkResult[], date: string) {
  const perCell = Map.groupBy(results, (r) => `${r.model}\n${r.scenario}`);
  const runs = Math.max(0, ...[...perCell.values()].map((rs) => rs.length));
  const markdown = benchmarkMarkdown(results, { date, runs });
  await writeFile(path.join(dir, "report.md"), markdown);
  console.log(`\n${markdown}`);
  console.log(`Report: ${path.relative(process.cwd(), path.join(dir, "report.md"))}`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      runs: { type: "string", default: "10" },
      models: { type: "string", default: "spark,glimmer" },
      scenarios: { type: "string", default: scenarios.map((s) => s.id).join(",") },
      concurrency: { type: "string", default: "3" },
      report: { type: "string" },
    },
  });

  if (values.report) {
    const dir = path.resolve(values.report);
    await writeReport(dir, await regrade(dir), path.basename(dir).slice(0, 10));
    return;
  }

  const runs = Number(values.runs);
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a whole number from 1");
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency must be a whole number from 1");
  const picked = values.scenarios.split(",").map((id): Scenario => {
    const s = getScenario(id.trim());
    if (!s?.expected) throw new Error(`"${id}": no scenario with ground truth by that id (${scenarios.map((x) => x.id).join(", ")})`);
    return s;
  });
  const efforts = { lanes: (await stageModel("investigate")).effort, lead: (await stageModel("lead")).effort };
  const models = await Promise.all(values.models.split(",").map((m) => parseSpec(m.trim(), efforts)));

  const started = new Date();
  const dir = path.join(process.cwd(), ".data", "benchmarks", started.toISOString().replace(/[:.]/g, "-").slice(0, 19));
  await mkdir(path.join(dir, "runs"), { recursive: true });

  // Round by round, so a benchmark stopped partway still has every
  // scenario and model about equally often.
  const jobs = Array.from({ length: runs }, (_, round) =>
    picked.flatMap((scenario) => models.map((m) => ({ round, scenario, ...m }))),
  ).flat();
  console.log(`Benchmark: ${jobs.length} runs (${runs} × ${picked.length} scenarios × ${models.length} models), ${concurrency} at a time.`);
  console.log(`Writing to ${path.relative(process.cwd(), dir)}\n`);

  let done = 0;
  const results = await pool(
    jobs.map(({ scenario, stage, lead }) => async () => {
      const incident = await runInvestigation(await scenarioIncident(scenario), createScenarioSource(scenario), {
        stage,
        // Explicit either way, so Settings' fan-out switch never applies.
        fanout: lead ? { lead } : false,
        // Saved once, below, instead of after every step.
        save: async () => {},
      });
      await writeFile(path.join(dir, "runs", `${incident.id}.json`), JSON.stringify(incident, null, 2));
      const result = scoreRun(incident, scenario.id, scenario.expected!);
      await appendFile(path.join(dir, "results.ndjson"), `${JSON.stringify(result)}\n`);
      const time = result.seconds === undefined ? "" : `, ${Math.round(result.seconds)} s`;
      const spent = result.cost === undefined ? "" : `, ${formatCost(result.cost)}`;
      console.log(
        `[${++done}/${jobs.length}] ${result.model} · ${scenario.id}: ${result.hit ? "hit" : "miss"} (${result.verdict}${time}${spent})` +
          (result.hit ? "" : `\n    ${result.reasons.join("; ")}`),
      );
      return result;
    }),
    concurrency,
  );

  await writeReport(dir, results, started.toISOString().slice(0, 10));
}

main().catch((err) => {
  console.error(`benchmark failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
