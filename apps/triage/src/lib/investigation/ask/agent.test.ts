import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import type { Stage } from "../fanout/run";
import { poolLeak, resolved } from "../postmortem/test-incidents";
import type { Incident, Question } from "../schema";
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
async function askQuestion(script: (call: Call) => Turn, base: Incident = poolLeak()) {
  const incident = { ...base, id: `inc_ask_${++n}` };
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

// The message as the asking tab builds it from the streamed response, after
// each chunk (questions-panel.tsx reads it the same way).
async function tabMessages(sse: string): Promise<UIMessage[]> {
  const chunks = sse
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice("data: ".length)) as UIMessageChunk);
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const messages: UIMessage[] = [];
  for await (const message of readUIMessageStream({ stream })) messages.push(message);
  return messages;
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
    const last = (await tabMessages(streamed)).at(-1)!;
    assert.ok(last.parts.some((p) => p.type === "text" && p.text.includes("Every connection was held open")));
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

describe("what happened after the alert", () => {
  it("is in the prompt after the cached prefix, and a cited series is kept as the question's evidence", async () => {
    const { saved, seen } = await askQuestion(
      () => ({ text: "Yes: every minute of the window stayed at 180 ms [ev_q1_verification]." }),
      resolved(),
    );
    const prompt = lastUserText(seen[0]);
    assert.match(prompt, /After the alert \(from the incident record/);
    assert.match(prompt, /Verification after the mitigation \[ev_q1_verification\]/);
    assert.match(prompt, /- Resolved at 2026-10-23T02:23:00\.000Z\./);
    // The report and the evidence come first, the record just before the question.
    assert.ok(prompt.indexOf("Evidence you may cite") < prompt.indexOf("After the alert"));
    assert.ok(prompt.indexOf("After the alert") < prompt.indexOf("Question: "));
    // A scenario's tools stay at the alert.
    assert.match(prompt, /Alert time \(the tools' "now"\)/);
    assert.match(seen[0].prompt.find((m) => m.role === "system")?.content as string, /"After the alert" record/);
    assert.equal(saved.status, "answered", saved.error);
    assert.deepEqual(saved.citedIds, ["ev_q1_verification"]);
    assert.deepEqual(saved.unknownIds, []);
    assert.deepEqual(
      saved.evidence.map((e) => [e.id, e.kind]),
      [["ev_q1_verification", "metric"]],
    );
  });

  it("tells the model its tools read past the alert on a live run", async () => {
    const live: Incident = { ...resolved(), detectedAt: new Date(Date.now() - 45 * 60_000).toISOString() };
    live.run = { ...live.run!, source: "live:shopfront" };
    const { saved, seen } = await askQuestion(() => ({ text: "Back under it [ev_q1_verification]." }), live);
    assert.equal(saved.mode, "tools");
    const [, past] = lastUserText(seen[0]).match(/The tools' "now": \S+, (\d+) min after the alert\. Their windows count back from it: a window of (\d+) min/) ?? [];
    assert.ok(Number(past) >= 44 && Number(past) <= 45, past);
  });

  it("keeps none of it when the answer cites none", async () => {
    const { saved } = await askQuestion(() => ({ text: "The pool was full [ev_metric_pool]." }), resolved());
    assert.deepEqual(saved.evidence, []);
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
    const [streamed] = await Promise.all([answer.toUIMessageStreamResponse().text(), answer.consumeStream()]);
    const saved = (await store.getIncident(incident.id))!.questions![0];
    return { saved, seen, streamed };
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

  it("streams reading the bundle to the tab as a step, before the answer", async () => {
    const { saved, streamed } = await askFull(() => ({ text: "Yes [ev_ctx_incident_1]." }));
    const messages = await tabMessages(streamed);
    const fullPart = (m: UIMessage) => m.parts.find((p) => p.type === "data-full-context") as { data: { status: string; summary?: string } } | undefined;
    const states = messages.map((m) => fullPart(m)?.data.status).filter(Boolean);
    assert.equal(states[0], "running");
    assert.equal(states.at(-1), "completed");
    const last = messages.at(-1)!;
    assert.equal(last.parts[0].type, "data-full-context", "the step comes before the model's parts");
    assert.equal(fullPart(last)!.data.summary, saved.steps[0].summary);
    assert.match(fullPart(last)!.data.summary!, /^Read about \d+k tokens: /);
    assert.ok(last.parts.some((p) => p.type === "text" && p.text === "Yes [ev_ctx_incident_1]."));
  });

  it("strikes an ID the bundle doesn't have", async () => {
    const { saved } = await askFull(() => ({ text: "It did [ev_ctx_incident_99]." }));
    assert.deepEqual(saved.citedIds, []);
    assert.deepEqual(saved.unknownIds, ["ev_ctx_incident_99"]);
    assert.deepEqual(saved.evidence, []);
  });
});
