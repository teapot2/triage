import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Stage } from "../fanout/run";
import { exampleIncidents } from "../fixtures";
import { InvestigationRecorder } from "../recorder";
import { createScenarioSource, getScenario } from "../scenarios";
import { type Call, inOrder, lastUserText, scriptedModel, toolOutputs, type Turn, turnOf } from "../scripted-model";
import { runFixStage } from "./agent";

// The fix stage's loop with a scripted model. Every submission here is
// turned back before the sandbox, so no app directory is needed.

const stage: Stage = { provider: "meta", model: "scripted", effort: "high", baseUrl: "http://127.0.0.1:9/v1", apiKey: "test" };

async function fix(script: (call: Call) => Turn) {
  const incident = structuredClone(exampleIncidents.find((i) => i.id === "inc_pool_leak")!);
  const recorder = new InvestigationRecorder({ ...incident, fixRun: undefined, fix: undefined }, async () => {});
  const seen: Call[] = [];
  await runFixStage(recorder, createScenarioSource(getScenario("pool-leak")!), "no-app-dir", {
    stage,
    languageModel: scriptedModel(script, seen),
  });
  return { incident: recorder.incident, seen };
}

const test = {
  file: "src/lib/stock.test.ts",
  name: "releases the connection when the row is missing",
  content: [
    'import { describe, it, expect } from "vitest";',
    "",
    'describe("getStockLevel", () => {',
    '  it("releases the connection when the row is missing", async () => {',
    "    expect(1).toBe(1);",
    "  });",
    "});",
  ].join("\n"),
};
const submission = {
  summary: "Release the pooled client in a finally block so a missing stock row no longer leaks it.",
  risk: "low",
  touchesData: false,
  edits: [{ file: "src/lib/stock.ts", find: "client.release();", replace: "" }],
  test,
};
const problemsOf = (call: Call, tool: string) =>
  (toolOutputs(call).findLast((o) => o.toolName === tool)?.value as { accepted: boolean; problems: string[] }).problems;

describe("runFixStage's loop", () => {
  it("hands each submission's problems back, then takes a decline after a nudge", async () => {
    const { incident, seen } = await fix(
      inOrder(
        // Too short a summary and a one-line test: turned back without
        // using up a submission.
        { tools: [["submit_fix", { ...submission, summary: "fix leak", test: { ...test, content: "it('x', () => {});" } }]] },
        // An edit outside the app's files: a submission spent, and rejected.
        { tools: [["submit_fix", { ...submission, edits: [{ file: "../elsewhere.ts", find: "a", replace: "b" }] }]] },
        { text: "I'm not sure this is a code defect." },
        { tools: [["decline_fix", { reason: "The leak is already fixed upstream." }]] },
      ),
    );
    assert.equal(seen.length, 4);

    const format = problemsOf(seen[1], "submit_fix");
    assert.equal(format.length, 2);
    assert.match(format[0], /^summary is 2 words \("fix leak"\)/);
    assert.match(format[1], /^test\.content is 1 line /);

    assert.deepEqual(problemsOf(seen[2], "submit_fix"), [
      "edits may only touch application files you can read; not: ../elsewhere.ts",
    ]);
    assert.match(lastUserText(seen[3]), /^You have not submitted a proven fix yet\./);

    assert.equal(incident.fixRun?.status, "declined");
    assert.equal(incident.fixRun?.declinedBecause, "The leak is already fixed upstream.");
    assert.equal(incident.fixRun?.attempt, 1);
    assert.deepEqual(incident.fixRun?.rejections, ["edits may only touch application files you can read; not: ../elsewhere.ts"]);
    assert.equal(incident.fixRun?.modelSteps, 4);
  });

  it("fails with the last problems once the nudges run out", async () => {
    const { incident, seen } = await fix((call) =>
      turnOf(call) === 0
        ? { tools: [["submit_fix", { ...submission, edits: [{ file: "../elsewhere.ts", find: "a", replace: "b" }] }]] }
        : { text: "Done." },
    );
    // The submission, then the plain answer and its two nudges.
    assert.equal(seen.length, 4);
    assert.equal(incident.fixRun?.status, "failed");
    assert.equal(incident.fixRun?.error, "edits may only touch application files you can read; not: ../elsewhere.ts");
  });
});
