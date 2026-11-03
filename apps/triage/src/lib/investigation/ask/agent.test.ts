import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Stage } from "../fanout/run";
import { poolLeak } from "../postmortem/test-incidents";
import type { Question } from "../schema";
import { type Call, inOrder, lastUserText, scriptedModel, type Turn, turnOf } from "../scripted-model";
import { closeDb } from "../../db";

// Ask's loop with a scripted model, streamed, on a temp working directory
// so .data is ours. The store resolves its folder when it loads, so it and
// the agent are imported after the chdir.

const cwd = process.cwd();
let dir: string;
let store: typeof import("../store");
let ask: typeof import("./agent");

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "triage-ask-"));
  process.chdir(dir);
  store = await import("../store");
  ask = await import("./agent");
});
after(async () => {
  process.chdir(cwd);
  // Windows may still hold a just-renamed file for a moment.
  closeDb();
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

const stage: Stage = { provider: "meta", model: "scripted", effort: "high", baseUrl: "http://127.0.0.1:9/v1", apiKey: "test" };

let n = 0;
// Asks the pool-leak incident (a scenario run, so with tools) a question and
// waits for the answer: what was streamed to the tab and what was saved.
async function askQuestion(script: (call: Call) => Turn) {
  const incident = { ...poolLeak(), id: `inc_ask_${++n}` };
  const question: Question = {
    id: "q_1",
    text: "Why did the pool run out?",
    askedAt: new Date().toISOString(),
    status: "answering",
    answer: "",
    citedIds: [],
    unknownIds: [],
    steps: [],
    evidence: [],
    mode: "tools",
    model: stage.model,
  };
  const asked = { ...incident, questions: [question] };
  await store.saveIncident(asked);
  const seen: Call[] = [];
  const answer = await ask.answerQuestion(asked, question, { stage, languageModel: scriptedModel(script, seen) });
  const [streamed] = await Promise.all([answer.toUIMessageStreamResponse().text(), answer.consumeStream()]);
  const saved = (await store.getIncident(incident.id))!.questions![0];
  return { saved, streamed, seen };
}

const lookup: Turn = { tools: [["db_diagnostics", { check: "activity" }]] };

describe("answerQuestion's loop", () => {
  it("nudges a run that stops after tool calls without answering", async () => {
    const { saved, streamed, seen } = await askQuestion(
      inOrder(lookup, {}, { text: "Every connection was held open [ev_metric_pool]." }),
    );
    assert.equal(seen.length, 3);
    assert.match(lastUserText(seen[2]), /^You have not answered yet\./);
    assert.equal(saved.status, "answered", saved.error);
    assert.equal(saved.answer, "Every connection was held open [ev_metric_pool].");
    assert.deepEqual(saved.citedIds, ["ev_metric_pool"]);
    assert.equal(saved.steps.length, 1);
    assert.match(streamed, /Every connection was held open/);
  });

  it("keeps text written beside tool calls out of the answer", async () => {
    const { saved, seen } = await askQuestion(
      (call) => [{ ...lookup, text: "Let me check Postgres." }, { text: "The pool was full [ev_metric_pool]." }][turnOf(call)],
    );
    assert.equal(seen.length, 2);
    assert.equal(saved.answer, "The pool was full [ev_metric_pool].");
  });

  it("doesn't nudge a run that ends without text or tool calls, and fails it", async () => {
    const { saved, seen } = await askQuestion(() => ({}));
    assert.equal(seen.length, 1);
    assert.equal(saved.status, "failed");
    assert.equal(saved.error, "No answer after 1 model steps");
  });
});

describe("a full-context question", () => {
  // The pool-leak incident asked with full context, a small budget, and one
  // earlier incident on the service.
  async function askFull(script: (call: Call) => Turn) {
    const incident = { ...poolLeak(), id: `inc_ask_${++n}` };
    const earlier = { ...poolLeak(), id: "inc_earlier", title: "Earlier pool exhaustion", detectedAt: "2026-10-01T10:00:00.000Z" };
    const question: Question = {
      id: "q_1",
      text: "Has this happened before?",
      askedAt: new Date().toISOString(),
      status: "answering",
      answer: "",
      citedIds: [],
      unknownIds: [],
      steps: [],
      evidence: [],
      mode: "full_context",
      model: stage.model,
    };
    const asked = { ...incident, questions: [question] };
    await store.saveIncident(asked);
    const seen: Call[] = [];
    const answer = await ask.answerQuestion(asked, question, {
      stage,
      languageModel: scriptedModel(script, seen),
      budget: 140_000,
      others: [earlier, incident],
    });
    await Promise.all([answer.toUIMessageStreamResponse().text(), answer.consumeStream()]);
    const saved = (await store.getIncident(incident.id))!.questions![0];
    return { saved, seen };
  }

  it("answers in one call with no tools, keeping only the cited items", async () => {
    const { saved, seen } = await askFull(() => ({
      text: "Yes: the same leak [ev_ctx_incident_1], in this code [ev_ctx_source_1_1] [ev_metric_pool].",
    }));
    assert.equal(seen.length, 1);
    const prompt = lastUserText(seen[0]);
    for (const part of ["<source>", "<changes>", "<incidents>", "<telemetry>"]) assert.ok(prompt.includes(part), part);
    assert.ok(prompt.indexOf("<source>") < prompt.indexOf("Incident: "), "the bundle comes before the report");
    assert.equal(saved.status, "answered", saved.error);
    assert.equal(saved.mode, "full_context");
    assert.deepEqual(saved.citedIds, ["ev_ctx_incident_1", "ev_ctx_source_1_1", "ev_metric_pool"]);
    assert.deepEqual(
      saved.evidence.map((e) => [e.id, e.kind]),
      [
        ["ev_ctx_incident_1", "incident"],
        ["ev_ctx_source_1_1", "source"],
      ],
    );
    const incidentEvidence = saved.evidence[0];
    assert.ok(incidentEvidence.kind === "incident" && incidentEvidence.incidentId === "inc_earlier");
    assert.equal(saved.steps.length, 1);
    assert.equal(saved.steps[0].tool, "full_context");
    assert.equal(saved.steps[0].status, "completed");
    assert.deepEqual(saved.steps[0].evidenceIds, ["ev_ctx_incident_1", "ev_ctx_source_1_1"]);
    assert.ok(saved.start?.parts.source && saved.start.parts.telemetry !== undefined);
  });

  it("strikes an ID the bundle doesn't have", async () => {
    const { saved } = await askFull(() => ({ text: "It did [ev_ctx_incident_99]." }));
    assert.deepEqual(saved.citedIds, []);
    assert.deepEqual(saved.unknownIds, ["ev_ctx_incident_99"]);
    assert.deepEqual(saved.evidence, []);
  });
});
