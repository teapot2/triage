import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Stage } from "../fanout/run";
import { poolLeak } from "../postmortem/test-incidents";
import type { Question } from "../schema";
import { type Call, inOrder, lastUserText, scriptedModel, type Turn, turnOf } from "../scripted-model";

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
