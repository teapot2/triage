import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ModelMessage, ToolLoopAgent, tool } from "ai";
import { z } from "zod";
import { noTokens } from "../models/usage";
import { runInvestigation, scenarioIncident } from "./agent";
import { runAgentLoop } from "./agent-loop";
import type { Stage } from "./fanout/run";
import { createScenarioSource, getScenario } from "./scenarios";
import {
  type Call,
  inOrder,
  lastUserText,
  rootCause,
  scriptedModel,
  toolNames,
  toolOutputs,
  type Turn,
  turnOf,
} from "./scripted-model";

describe("runAgentLoop", () => {
  // An agent with two tools, look and finish, capped at `maxSteps`.
  function loop(script: (call: Call) => Turn, { maxSteps = 10, maxNudges = 2, stream = false } = {}) {
    const seen: Call[] = [];
    let finished = false;
    let steps = 0;
    const agent = new ToolLoopAgent({
      model: scriptedModel(script, seen),
      tools: {
        look: tool({ inputSchema: z.object({}), execute: async () => "Nothing new." }),
        finish: tool({
          inputSchema: z.object({}),
          execute: async () => {
            finished = true;
            return "Finished.";
          },
        }),
      },
      stopWhen: [() => steps >= maxSteps, () => finished],
      prepareStep: () => {
        steps += 1;
        return {};
      },
    });
    const messages: ModelMessage[] = [{ role: "user", content: "Go." }];
    const tokens = noTokens();
    const run = runAgentLoop({
      agent,
      messages,
      abortSignal: new AbortController().signal,
      steps: () => steps,
      maxSteps,
      maxNudges,
      nudge: "Call finish now.",
      done: () => finished,
      tokens,
      ...(stream && { read: async (result: { text: PromiseLike<string> }) => (await result.text) === "Settled." }),
    });
    return run.then(() => ({ seen, messages, tokens, finished, steps }));
  }

  it("nudges a run that stops in plain text, and stops once done", async () => {
    const { seen, messages, tokens, finished } = await loop((call) =>
      turnOf(call) === 0 ? { text: "Thinking it over." } : { tools: [["finish", {}]] },
    );
    assert.equal(finished, true);
    assert.deepEqual(seen.map(lastUserText), ["Go.", "Call finish now."]);
    // The prompt, the plain answer, the nudge, then the call and its result.
    assert.deepEqual(
      messages.map((m) => m.role),
      ["user", "assistant", "user", "assistant", "tool"],
    );
    assert.equal(tokens.inputTokens, 200);
  });

  it("gives up after maxNudges", async () => {
    const { seen, finished } = await loop(() => ({ text: "No." }), { maxNudges: 2 });
    assert.equal(finished, false);
    assert.equal(seen.length, 3);
  });

  it("doesn't nudge an agent with no steps left", async () => {
    const { seen, steps } = await loop(
      () => ({ tools: [["look", {}]] }),
      { maxSteps: 2 },
    );
    assert.equal(steps, 2);
    assert.equal(seen.length, 2);
  });

  it("streams each run through read, which can settle it without a nudge", async () => {
    const { seen, tokens } = await loop(() => ({ text: "Settled." }), { stream: true });
    assert.equal(seen.length, 1);
    assert.equal(tokens.inputTokens, 100);

    const nudged = await loop((call) => (turnOf(call) === 0 ? { text: "Not yet." } : { tools: [["finish", {}]] }), { stream: true });
    assert.equal(nudged.finished, true);
    assert.equal(nudged.seen.length, 2);
  });
});

// The single investigating agent's loop, on the pool-leak scenario.

const stage: Stage = { provider: "meta", model: "scripted", effort: "high", baseUrl: "http://127.0.0.1:9/v1", apiKey: "test" };
const NUDGE = /^You have not submitted an accepted report yet\./;

async function investigate(script: (call: Call) => Turn, scenario = "pool-leak") {
  const s = getScenario(scenario)!;
  const seen: Call[] = [];
  const incident = await runInvestigation(await scenarioIncident(s), createScenarioSource(s), {
    stage,
    fanout: false,
    save: async () => {},
    languageModel: () => scriptedModel(script, seen),
  });
  return { incident, seen };
}

// The first turn queries what the report cites: ev_metric_1 and ev_db_1.
const survey: Turn = {
  text: "Looking.",
  tools: [
    ["query_metrics", { metrics: ["http.server.request.rate"] }],
    ["db_diagnostics", { check: "activity" }],
  ],
};
const report = rootCause({ symptom: "ev_metric_1", cause: "ev_db_1", ruledOut: "ev_metric_1" });

describe("runInvestigation's loop", () => {
  it("nudges an agent that stops in plain text, then takes its report", async () => {
    const { incident, seen } = await investigate(
      inOrder(survey, { text: "It looks like a pool leak." }, { tools: [["submit_report", report]] }),
    );
    assert.equal(incident.status, "diagnosed", incident.run?.error);
    assert.equal(seen.length, 3);
    assert.match(lastUserText(seen[2]), NUDGE);
    assert.doesNotMatch(lastUserText(seen[1]), NUDGE);
    assert.equal(incident.run?.modelSteps, 3);
  });

  it("fails the run once its nudges run out", async () => {
    const { incident, seen } = await investigate(() => ({ text: "Still thinking." }));
    assert.equal(seen.length, 3);
    assert.equal(incident.status, "failed");
    // Stopped with steps to spare: not out of steps.
    assert.equal(incident.run?.error, "The model stopped without submitting a report after 3 steps");
    assert.equal(incident.run?.modelSteps, 3);
  });

  it("keeps the steps and tokens a run spent when its model fails part-way", async () => {
    const { incident } = await investigate(inOrder(survey, { tools: [["query_logs", { service: "shopfront" }]] }, new Error("model fell over")));
    assert.equal(incident.status, "failed");
    assert.match(incident.run?.error ?? "", /model fell over/);
    assert.equal(incident.run?.modelSteps, 3);
    // Two calls answered (100 in, 10 out each); the third threw.
    assert.equal(incident.run?.inputTokens, 200);
    assert.equal(incident.run?.outputTokens, 20);
  });

  it("counts a successful run's tokens once", async () => {
    const { incident } = await investigate(inOrder(survey, { tools: [["submit_report", report]] }));
    assert.equal(incident.status, "diagnosed", incident.run?.error);
    assert.equal(incident.run?.inputTokens, 200);
    assert.equal(incident.run?.outputTokens, 20);
  });

  it("hands a rejected report's problems back, and takes the fixed one", async () => {
    const unknown = rootCause({ symptom: "ev_metric_1", cause: "ev_db_9", ruledOut: "ev_metric_1" });
    const { incident, seen } = await investigate(
      inOrder(survey, { tools: [["submit_report", unknown]] }, { tools: [["submit_report", report]] }),
    );
    const rejected = toolOutputs(seen[2]).find((o) => o.toolName === "submit_report")?.value as {
      accepted: boolean;
      problems: string[];
    };
    assert.equal(rejected.accepted, false);
    assert.ok(rejected.problems.some((p) => p.includes("ev_db_9")), rejected.problems.join("\n"));
    assert.equal(incident.status, "diagnosed", incident.run?.error);
    assert.equal(incident.run?.rejectedReports, 1);
    // What it got wrong is kept on the run, for the timeline.
    assert.equal(incident.run?.reportRejections?.length, 1);
    assert.match(incident.run?.reportRejections?.[0] ?? "", /ev_db_9/);
    assert.equal(incident.report?.hypotheses[0].causalChain?.rootCause.evidenceIds[0], "ev_db_1");
  });

  it("leaves only submit_report for the last steps before the cap", async () => {
    const { incident, seen } = await investigate((call) => {
      if (turnOf(call) === 0) return survey;
      if (toolNames(call).length === 1) return { tools: [["submit_report", report]] };
      return { tools: [["query_logs", { service: "shopfront", minLevel: "warn" }]] };
    });
    const gated = seen.findIndex((c) => toolNames(c).length === 1);
    // MAX_STEPS 30 less SUBMIT_RESERVE 4: steps 1 to 26 have every tool.
    assert.equal(gated, 26);
    assert.ok(seen.slice(0, gated).every((c) => toolNames(c).length === 8));
    assert.deepEqual(toolNames(seen[gated]), ["submit_report"]);
    assert.equal(incident.status, "diagnosed", incident.run?.error);
    assert.equal(incident.run?.modelSteps, 27);
  });

  it("sends back a root cause resting on a flag that is off, and takes a different verdict", async () => {
    // traffic-rush: every flag is off at the alert ("flags: loaded" at boot).
    const onFlag = rootCause({ symptom: "ev_metric_1", cause: "ev_db_1", ruledOut: "ev_metric_1" });
    onFlag.hypotheses[0].title = "FF_LIVE_RATINGS reviews loop slows every listing";
    const load = rootCause({ symptom: "ev_metric_1", cause: "ev_metric_1", ruledOut: "ev_db_1" });
    load.summary = "Every page slowed when the request rate tripled; nothing is broken.";
    load.hypotheses[0].title = "Request rate tripled";
    load.hypotheses[0].causalChain.rootCause.text = "Traffic rose from 2 to 6 requests per second";
    const { incident, seen } = await investigate(
      inOrder(survey, { tools: [["submit_report", onFlag]] }, { tools: [["submit_report", load]] }),
      "traffic-rush",
    );
    const rejected = toolOutputs(seen[2]).find((o) => o.toolName === "submit_report")?.value as {
      accepted: boolean;
      problems: string[];
    };
    assert.equal(rejected.accepted, false);
    // Rejected for that alone: the report passes every other check.
    assert.deepEqual(
      rejected.problems,
      [
        "The root cause of A depends on FF_LIVE_RATINGS (it names FF_LIVE_RATINGS), but the logs show it was off at the alert (07:21); code behind it isn't running now. Rule it out, or name what is causing this now. If something it left behind while it was on is still the cause (resources it still holds, data it wrote), say so, and that FF_LIVE_RATINGS is off.",
      ],
    );
    assert.equal(incident.status, "diagnosed", incident.run?.error);
    assert.equal(incident.run?.rejectedReports, 1);
    assert.match(incident.run?.reportRejections?.[0] ?? "", /depends on FF_LIVE_RATINGS/);
    assert.equal(incident.report?.hypotheses[0].title, "Request rate tripled");
  });
});
