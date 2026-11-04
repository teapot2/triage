import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInvestigation, scenarioIncident } from "../agent";
import { InvestigationRecorder } from "../recorder";
import { createScenarioSource, getScenario } from "../scenarios";
import { evidenceId, type Incident } from "../schema";
import {
  type Call,
  claim,
  rootCause,
  scriptedModel,
  systemText,
  toolNames,
  toolResults,
  type Turn,
  turnOf,
  userText,
} from "../scripted-model";
import { LaneRecorder } from "./lane-recorder";
import type { Stage } from "./run";

// A scripted model: each phase of the run (told apart by its tools and
// prompt) answers turn by turn, and every call is kept for the asserts.

type Phase = "scout" | "h1" | "h2" | "h3" | "merge" | "single";
type Script = Partial<Record<Phase, (turn: number, call: Call) => Turn>>;
type Seen = { phase: Phase; model: string; call: Call };

const laneStage: Stage = { provider: "meta", model: "lane-model", effort: "high", baseUrl: "http://127.0.0.1:9/v1", apiKey: "test" };
const lead: Stage = { ...laneStage, model: "lead-model" };

function phaseOf(call: Call): Phase {
  const tools = toolNames(call);
  if (tools.includes("propose_hypotheses")) return "scout";
  if (tools.includes("submit_finding")) return userText(call).match(/Hypothesis (h\d):/)![1] as Phase;
  return systemText(call).includes("A finding is input, not a vote") ? "merge" : "single";
}

function scripted(model: string, script: Script, seen: Seen[]) {
  return scriptedModel(
    (call) => {
      const phase = phaseOf(call);
      seen.push({ phase, model, call });
      const turn = turnOf(call);
      return script[phase]?.(turn, call) ?? { text: `no script for ${phase} turn ${turn}` };
    },
    [],
    model,
  );
}

async function investigate(script: Script, { fanout = true, scenario = "pool-leak" } = {}) {
  const s = getScenario(scenario)!;
  const seen: Seen[] = [];
  const incident = await runInvestigation(await scenarioIncident(s), createScenarioSource(s), {
    stage: laneStage,
    // Always given, so the worktree's Settings never decide.
    fanout: fanout && { lead },
    save: async () => {},
    languageModel: (stage) => scripted(stage.model, script, seen),
  });
  return { incident, seen };
}

const poolAlert = getScenario("pool-leak")!.alert.metric;

// The scout surveys once, then proposes the pool leak and a traffic spike.
const scout = (alert: string): Script["scout"] => (turn) =>
  turn === 0
    ? {
        text: "Surveying the alert and logs.",
        tools: [
          ["query_metrics", { metrics: [alert, "http.server.request.rate"] }],
          ["query_logs", { service: "shopfront", minLevel: "warn" }],
        ],
      }
    : {
        tools: [
          [
            "propose_hypotheses",
            {
              hypotheses: [
                { title: "Connection pool leak", claim: "Connections are never released", check: ["postgres activity"], evidenceIds: ["ev_metric_1"] },
                { title: "Traffic spike", claim: "Load rose before the latency did", check: ["request rate"], evidenceIds: ["ev_metric_2"] },
              ],
            },
          ],
        ],
      };

// h1 finds idle connections and supports its hypothesis; h2 finds a flat
// request rate and refutes its own.
const supportedLane: Script["h1"] = (turn) =>
  turn === 0
    ? { text: "Checking Postgres.", tools: [["db_diagnostics", { check: "activity" }]] }
    : {
        tools: [
          [
            "submit_finding",
            { finding: "supported", reason: "Idle connections pile up", evidenceFor: ["ev_h1_db_1", "ev_metric_1"], evidenceAgainst: [] },
          ],
        ],
      };
const refutedLane: Script["h2"] = (turn) =>
  turn === 0
    ? { tools: [["query_metrics", { metrics: ["http.server.request.rate"] }]] }
    : {
        tools: [
          [
            "submit_finding",
            { finding: "refuted", reason: "Request rate stayed flat", evidenceFor: [], evidenceAgainst: ["ev_h2_metric_1"] },
          ],
        ],
      };
const mergeReport: Script["merge"] = () => ({
  tools: [["submit_report", rootCause({ symptom: "ev_metric_1", cause: "ev_h1_db_1", ruledOut: "ev_h2_metric_1" })]],
});

const lanesOf = (incident: Incident) => [...new Set(incident.steps.map((s) => s.lane))];

describe("LaneRecorder", () => {
  it("gives a lane's evidence its own IDs, on the incident beside the scout's", async () => {
    const recorder = new InvestigationRecorder(await scenarioIncident(getScenario("pool-leak")!), async () => {});
    const lane = new LaneRecorder("h1", recorder);
    const log = { kind: "log" as const, summary: "3x error", service: "shopfront", level: "error" as const, message: "boom" };
    recorder.startStep("call_a", "query_logs", {});
    const [scoutLog] = recorder.completeStep("call_a", "query_logs", "1 log group", [log]);
    lane.startThought("th_1");
    lane.startStep("call_b", "query_logs", {});
    const [laneLog] = lane.completeStep("call_b", "query_logs", "1 log group", [log]);
    assert.deepEqual([scoutLog.id, laneLog.id], ["ev_log_1", "ev_h1_log_1"]);
    for (const e of [scoutLog, laneLog]) assert.ok(evidenceId.safeParse(e.id).success, e.id);
    assert.deepEqual(recorder.evidence.map((e) => e.id), ["ev_log_1", "ev_h1_log_1"]);
    assert.deepEqual(lane.evidence.map((e) => e.id), ["ev_h1_log_1"]);
    const step = recorder.incident.steps.find((s) => s.id === "call_b")!;
    assert.deepEqual([step.lane, step.turn, step.evidenceIds], ["h1", "th_1", ["ev_h1_log_1"]]);
    assert.equal(recorder.incident.steps.find((s) => s.id === "call_a")!.lane, undefined);
    assert.equal(recorder.incident.thoughts?.[0].lane, "h1");
    await recorder.flush();
  });
});

// One scripted call's tokens, as a record's context keeps it.
const call = { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, reasoningTokens: 0 };

describe("runFanout", () => {
  it("runs scout, lanes and merge, with lane evidence IDs apart from the scout's", async () => {
    const { incident, seen } = await investigate({
      scout: scout(poolAlert),
      h1: supportedLane,
      h2: refutedLane,
      merge: mergeReport,
    });
    assert.equal(incident.status, "diagnosed", incident.run?.error);

    const ids = incident.evidence.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, "evidence IDs are unique");
    for (const id of ids) assert.ok(evidenceId.safeParse(id).success, id);
    const scoutIds = incident.steps.filter((s) => s.lane === "scout").flatMap((s) => s.evidenceIds);
    assert.ok(scoutIds.includes("ev_metric_1") && scoutIds.every((id) => /^ev_(metric|log)_\d+$/.test(id)), scoutIds.join());
    assert.deepEqual(incident.steps.filter((s) => s.lane === "h1").flatMap((s) => s.evidenceIds), ["ev_h1_db_1"]);
    assert.deepEqual(incident.steps.filter((s) => s.lane === "h2").flatMap((s) => s.evidenceIds), ["ev_h2_metric_1"]);

    // Every step and thought says which part ran it, on the right model.
    assert.deepEqual(lanesOf(incident).sort(), ["h1", "h2", "scout"]);
    assert.deepEqual(incident.thoughts?.map((t) => t.lane), ["scout", "h1"]);
    assert.deepEqual(
      [...new Set(seen.map((s) => `${s.phase}:${s.model}`))].sort(),
      ["h1:lane-model", "h2:lane-model", "merge:lead-model", "scout:lead-model"],
    );

    assert.deepEqual(incident.run?.fanout, {
      leadProvider: "meta",
      leadModel: "lead-model",
      leadReasoningEffort: "high",
      // The lead's tokens: 2 scout calls and 1 merge call.
      inputTokens: 300,
      cachedInputTokens: 0,
      outputTokens: 30,
      reasoningTokens: 0,
      // Its fullest single call, not the sum: every scripted call is 100 in.
      context: call,
      hypotheses: [
        {
          id: "h1",
          title: "Connection pool leak",
          claim: "Connections are never released",
          finding: "supported",
          reason: "Idle connections pile up",
          evidenceFor: ["ev_h1_db_1", "ev_metric_1"],
          evidenceAgainst: [],
          steps: 2,
          context: call,
        },
        {
          id: "h2",
          title: "Traffic spike",
          claim: "Load rose before the latency did",
          finding: "refuted",
          reason: "Request rate stayed flat",
          evidenceFor: [],
          evidenceAgainst: ["ev_h2_metric_1"],
          steps: 2,
          context: call,
        },
      ],
    });
    // Every phase's steps count: 2 scout + 2 + 2 lanes + 1 merge. The run's
    // tokens are the lanes' 4 calls; the lead's are on the fan-out, above.
    assert.equal(incident.run?.modelSteps, 7);
    assert.equal(incident.run?.inputTokens, 400);
    assert.equal(incident.run?.outputTokens, 40);
    // The run's context is its fullest lane call, as the lanes' each are.
    assert.deepEqual(incident.run?.context, call);
  });

  it("hands a refuted lane's evidence and finding to the merge, which can cite it", async () => {
    const { incident, seen } = await investigate({
      scout: scout(poolAlert),
      h1: supportedLane,
      h2: refutedLane,
      merge: mergeReport,
    });
    const merge = seen.find((s) => s.phase === "merge")!.call;
    const text = userText(merge);
    assert.match(text, /"id":"ev_h2_metric_1"/);
    assert.match(text, /h2: Traffic spike\n {2}Claim: Load rose before the latency did\n {2}Finding: refuted: Request rate stayed flat/);
    assert.match(text, /against: ev_h2_metric_1/);
    // The lanes' services count toward the gate: only h1 queried Postgres.
    assert.ok(incident.report, incident.run?.error);
    assert.deepEqual(incident.report.servicesQueried, ["postgres", "shopfront"]);
    assert.ok(incident.report.hypotheses[1].rejectedBecause?.evidenceIds.includes("ev_h2_metric_1"));
    assert.equal(incident.run?.rejectedReports, 0);
  });

  it("records a lane that throws as unclear with its error, and still merges", async () => {
    const { incident, seen } = await investigate({
      scout: scout(poolAlert),
      h1: supportedLane,
      h2: (turn) => (turn === 0 ? { tools: [["query_metrics", { metrics: ["http.server.request.rate"] }]] } : new Error("lane model fell over")),
      merge: mergeReport,
    });
    const h2 = incident.run?.fanout?.hypotheses.find((h) => h.id === "h2");
    assert.equal(h2?.finding, "unclear");
    assert.match(h2?.error ?? "", /lane model fell over/);
    assert.equal(h2?.steps, 2);
    // What it gathered before it failed is still evidence for the merge.
    assert.match(userText(seen.find((s) => s.phase === "merge")!.call), /h2: Traffic spike[\s\S]*Finding: unclear \(the check failed: lane model fell over\)/);
    assert.equal(incident.status, "diagnosed", incident.run?.error);
    // Its one answered call's tokens count, beside h1's two.
    assert.equal(incident.run?.inputTokens, 300);
  });

  it("nudges a lane that stops without a finding once, then counts it unclear", async () => {
    const { incident, seen } = await investigate({
      scout: (turn) =>
        turn === 0
          ? { tools: [["query_metrics", { metrics: ["http.server.request.rate"] }], ["db_diagnostics", { check: "activity" }]] }
          : { tools: [["propose_hypotheses", { hypotheses: [{ title: "Pool leak", claim: "Leak", check: [], evidenceIds: [] }] }]] },
      h1: () => ({ text: "I think it is a leak." }),
      merge: () => ({ tools: [["submit_report", rootCause({ symptom: "ev_metric_1", cause: "ev_db_1", ruledOut: "ev_metric_1" })]] }),
    });
    const lane = seen.filter((s) => s.phase === "h1");
    assert.equal(lane.length, 2);
    assert.match(userText(lane[1].call), /You have not submitted a finding yet/);
    assert.deepEqual(
      incident.run?.fanout?.hypotheses.map((h) => [h.finding, h.error]),
      [["unclear", "No finding after 2 model steps"]],
    );
    assert.equal(incident.status, "diagnosed", incident.run?.error);
  });

  it("skips the lanes when the scout proposes no hypotheses", async () => {
    const healthy = getScenario("healthy")!;
    const { incident, seen } = await investigate(
      {
        scout: (turn) =>
          turn === 0
            ? { tools: [["query_metrics", { metrics: [healthy.alert.metric] }], ["db_diagnostics", { check: "activity" }]] }
            : { tools: [["propose_hypotheses", { hypotheses: [] }]] },
        merge: () => ({
          tools: [
            [
              "submit_report",
              {
                summary: "Nothing is wrong: latency is at its usual level.",
                hypotheses: [],
                verdict: { kind: "healthy", rationale: claim("Latency stayed at its baseline", "ev_metric_1") },
              },
            ],
          ],
        }),
      },
      { scenario: "healthy" },
    );
    assert.deepEqual([...new Set(seen.map((s) => s.phase))], ["scout", "merge"]);
    assert.match(userText(seen.find((s) => s.phase === "merge")!.call), /proposed no hypotheses/);
    assert.deepEqual(incident.run?.fanout?.hypotheses, []);
    assert.equal(incident.status, "healthy", incident.run?.error);
    assert.equal(incident.run?.modelSteps, 3);
  });

  it("still rejects a merge report that cites an unknown evidence ID", async () => {
    const { incident, seen } = await investigate({
      scout: scout(poolAlert),
      h1: supportedLane,
      h2: refutedLane,
      merge: (turn) => ({
        tools: [
          [
            "submit_report",
            rootCause({ symptom: "ev_metric_1", cause: turn === 0 ? "ev_h3_log_9" : "ev_h1_db_1", ruledOut: "ev_h2_metric_1" }),
          ],
        ],
      }),
    });
    const second = seen.filter((s) => s.phase === "merge")[1].call;
    const rejection = toolResults(second).find((r) => r.accepted === false);
    assert.deepEqual(rejection?.problems, ["unknown evidence IDs cited: ev_h3_log_9"]);
    assert.equal(incident.run?.rejectedReports, 1);
    assert.equal(incident.status, "diagnosed", incident.run?.error);
  });

  it("rejects a finding that cites evidence the lane can't see", async () => {
    const { incident, seen } = await investigate({
      scout: scout(poolAlert),
      h1: supportedLane,
      h2: (turn, call) =>
        turn === 0
          ? { tools: [["query_metrics", { metrics: ["http.server.request.rate"] }]] }
          : turn === 1
            ? { tools: [["submit_finding", { finding: "refuted", reason: "Flat", evidenceFor: [], evidenceAgainst: ["ev_h2_log_42"] }]] }
            : (refutedLane(1, call) as Turn),
      merge: mergeReport,
    });
    const third = seen.filter((s) => s.phase === "h2")[2].call;
    assert.deepEqual(toolResults(third).at(-1)?.problems, ["unknown evidence IDs cited: ev_h2_log_42"]);
    assert.equal(incident.run?.fanout?.hypotheses[1].finding, "refuted");
  });

  it("falls back to the single agent, from the scout's evidence, when the scout fails", async () => {
    const { incident, seen } = await investigate({
      scout: (turn) =>
        turn === 0
          ? { tools: [["query_metrics", { metrics: ["http.server.request.rate"] }], ["db_diagnostics", { check: "activity" }]] }
          : new Error("lead model down"),
      single: (turn) =>
        turn === 0
          ? { tools: [["query_logs", { service: "shopfront", minLevel: "error" }]] }
          : { tools: [["submit_report", rootCause({ symptom: "ev_metric_1", cause: "ev_db_1", ruledOut: "ev_metric_1" })]] },
    });
    const first = seen.find((s) => s.phase === "single")!;
    assert.equal(first.model, "lane-model");
    assert.match(userText(first.call), /Evidence gathered so far[\s\S]*"id":"ev_db_1"/);
    // The scout's steps stay, tagged; the single agent's carry no lane.
    assert.deepEqual(
      incident.steps.map((s) => [s.tool, s.lane]),
      [
        ["query_metrics", "scout"],
        ["db_diagnostics", "scout"],
        ["query_logs", undefined],
      ],
    );
    assert.deepEqual(incident.run?.fanout?.hypotheses, []);
    assert.equal(incident.run?.modelSteps, 4);
    assert.equal(incident.status, "diagnosed", incident.run?.error);
  });

  it("hands over to the single agent, with every finding, when the merge ends without a report", async () => {
    const { incident, seen } = await investigate({
      scout: scout(poolAlert),
      h1: supportedLane,
      h2: refutedLane,
      merge: () => ({ text: "The pool leak looks right." }),
      single: () => ({
        tools: [["submit_report", rootCause({ symptom: "ev_metric_1", cause: "ev_h1_db_1", ruledOut: "ev_h2_metric_1" })]],
      }),
    });
    // The merge was nudged once, then the stage's model took over.
    assert.equal(seen.filter((s) => s.phase === "merge").length, 2);
    const single = seen.find((s) => s.phase === "single")!;
    assert.equal(single.model, "lane-model");
    const text = userText(single.call);
    assert.match(text, /Evidence gathered so far[\s\S]*"id":"ev_h2_metric_1"/);
    assert.match(text, /Hypotheses checked so far[\s\S]*h1: Connection pool leak[\s\S]*Finding: supported: Idle connections pile up/);
    assert.match(text, /h2: Traffic spike[\s\S]*Finding: refuted: Request rate stayed flat/);
    assert.equal(incident.status, "diagnosed", incident.run?.error);
    // 2 scout + 4 lanes + 2 merge + 1 alone, within the run's 30.
    assert.equal(incident.run?.modelSteps, 9);
    // The lead's 4 calls on the fan-out; the lanes' 4 and the fallback's 1
    // on the run, at the stage's model.
    assert.equal(incident.run?.fanout?.inputTokens, 400);
    assert.equal(incident.run?.inputTokens, 500);
  });

  it("hands over to the single agent when the merge's model fails", async () => {
    const { incident, seen } = await investigate({
      scout: scout(poolAlert),
      h1: supportedLane,
      h2: refutedLane,
      merge: () => new Error("lead model down"),
      single: () => ({
        tools: [["submit_report", rootCause({ symptom: "ev_metric_1", cause: "ev_h1_db_1", ruledOut: "ev_h2_metric_1" })]],
      }),
    });
    assert.match(userText(seen.find((s) => s.phase === "single")!.call), /Hypotheses checked so far/);
    assert.equal(incident.status, "diagnosed", incident.run?.error);
  });

  it("keeps the lead's and the lanes' tokens on a run that fails part-way", async () => {
    const { incident } = await investigate({
      scout: scout(poolAlert),
      h1: supportedLane,
      h2: refutedLane,
      merge: () => new Error("lead model down"),
      single: () => new Error("model down too"),
    });
    assert.equal(incident.status, "failed");
    assert.match(incident.run?.error ?? "", /model down too/);
    // 2 scout + 2 + 2 lanes + the merge's and the single agent's failed calls.
    assert.equal(incident.run?.modelSteps, 8);
    assert.equal(incident.run?.inputTokens, 400);
    assert.equal(incident.run?.fanout?.inputTokens, 200);
  });
});

describe("runInvestigation without a fan-out", () => {
  it("runs the single agent as before: its tools and prompt, no lanes", async () => {
    const { incident, seen } = await investigate(
      {
        single: (turn) =>
          turn === 0
            ? { text: "Looking.", tools: [["query_metrics", { metrics: ["http.server.request.rate"] }], ["db_diagnostics", { check: "activity" }]] }
            : { tools: [["submit_report", rootCause({ symptom: "ev_metric_1", cause: "ev_db_1", ruledOut: "ev_metric_1" })]] },
      },
      { fanout: false },
    );
    assert.deepEqual(
      seen.map((s) => [s.phase, s.model]),
      [
        ["single", "lane-model"],
        ["single", "lane-model"],
      ],
    );
    const first = seen[0].call;
    assert.deepEqual(toolNames(first), [
      "db_diagnostics",
      "deploy_history",
      "git_log",
      "query_logs",
      "query_metrics",
      "query_traces",
      "read_source",
      "submit_report",
    ]);
    assert.match(systemText(first), /^You are Triage, an SRE investigating a production alert for a small team with no SRE\.\n\nMethod:\n1\. /);
    assert.match(systemText(first), /\n\nRules:\n- Every claim must cite[\s\S]*- Finish by calling submit_report\. If it is rejected, fix the listed problems and submit again\.$/);
    assert.match(userText(first), /^Alert: [\s\S]*\nInvestigate and submit your report\.$/);
    assert.equal(incident.run?.fanout, undefined);
    assert.ok(incident.steps.every((s) => !("lane" in s)));
    assert.ok(incident.thoughts?.length && incident.thoughts.every((t) => !("lane" in t)));
    assert.deepEqual([incident.status, incident.run?.modelSteps, incident.run?.inputTokens], ["diagnosed", 2, 200]);
  });
});
