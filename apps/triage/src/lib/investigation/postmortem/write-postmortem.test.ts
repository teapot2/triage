import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Stage } from "../fanout/run";
import { exampleIncidents } from "../fixtures";
import { type Call, inOrder, lastUserText, scriptedModel, toolOutputs, type Turn } from "../scripted-model";
import { nextPostmortem, type PostmortemSubmission } from "./rules";
import { defaultTemplate } from "./template";
import { closeDb } from "../../db";

// The postmortem writer's loop with a scripted model, streamed, on a temp
// working directory so .data is ours. The store resolves its folder when it
// loads, so it and the writer are imported after the chdir.

const cwd = process.cwd();
let dir: string;
let store: typeof import("../store");
let writer: typeof import("./writer");

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "triage-postmortem-"));
  process.chdir(dir);
  store = await import("../store");
  writer = await import("./writer");
});
after(async () => {
  process.chdir(cwd);
  // Windows may still hold a just-renamed file for a moment.
  closeDb();
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

const stage: Stage = { provider: "meta", model: "scripted", effort: "high", baseUrl: "http://127.0.0.1:9/v1", apiKey: "test" };

// A submission postmortemProblems accepts for the pool leak (see rules.test.ts).
const valid: PostmortemSubmission = {
  summary:
    "Product pages timed out for eleven minutes after a deploy. A missing stock row leaked a pooled connection on every request. Turning the flag off stopped it.",
  impact: { text: "Product page requests waited 3 s and failed with 500s.", evidenceIds: ["ev_metric_p95", "ev_log_timeout"] },
  contributingFactors: [
    { text: "getStockLevel returned before releasing its client on a missing row.", evidenceIds: ["ev_source_stock"] },
    { text: "The flag put that path on every product request.", evidenceIds: ["ev_commit_flag", "ev_log_stock_miss"] },
    { text: "The pool holds only 10 connections, so it ran out in minutes.", evidenceIds: ["ev_metric_pool"] },
  ],
  verdictReview: {
    text: "The diagnosis held: the regression test failed on the original code and passes with the fix.",
    evidenceIds: ["ev_source_stock"],
  },
  wentWell: [{ text: "The latency alert fired as the pool ran out.", evidenceIds: ["ev_metric_p95"] }],
  wentBadly: [{ text: "Nothing alerted on pool saturation itself.", evidenceIds: ["ev_metric_pool"] }],
  lucky: ["Traffic was flat; a spike would have run the pool out sooner."],
  actionItems: [
    { title: "Alert when the pool stays above 80% in use", kind: "detect_sooner", priority: "P2", evidenceIds: ["ev_metric_pool"] },
    { title: "Lint for pooled clients released outside finally", kind: "prevent_class", priority: "P2" },
  ],
};
const unknownId: PostmortemSubmission = { ...valid, wentWell: [{ text: "The alert fired.", evidenceIds: ["ev_nope"] }] };
const submit = (s: PostmortemSubmission): Turn => ({ tools: [["submit_postmortem", s]] });

let n = 0;
// Writes the pool leak's postmortem and returns it as saved.
async function write(script: (call: Call) => Turn) {
  const incident = structuredClone(exampleIncidents.find((i) => i.id === "inc_pool_leak")!);
  const id = `inc_pm_loop_${++n}`;
  await store.saveIncident({ ...incident, id, postmortem: { ...nextPostmortem(stage), template: defaultTemplate } });
  const seen: Call[] = [];
  await writer.writePostmortem(id, { stage, languageModel: scriptedModel(script, seen) });
  return { postmortem: (await store.getIncident(id))!.postmortem!, seen };
}

describe("writePostmortem's loop", () => {
  it("nudges a writer that answers in plain text, hands a rejection back, and takes the fixed submission", async () => {
    const { postmortem, seen } = await write(inOrder({ text: "Drafting the postmortem." }, submit(unknownId), submit(valid)));
    assert.equal(seen.length, 3);
    assert.match(lastUserText(seen[1]), /^You have not submitted an accepted postmortem yet\./);
    const rejected = toolOutputs(seen[2]).find((o) => o.toolName === "submit_postmortem")?.value;
    assert.match(String(rejected), /^Rejected:\n- unknown evidence IDs cited: ev_nope\./);
    assert.equal(postmortem.status, "ready", postmortem.error);
    assert.equal(postmortem.summary, valid.summary);
    assert.equal(postmortem.draft, undefined);
    assert.equal(postmortem.inputTokens, 300);
  });

  it("stops at its step cap without a nudge, failed with the last problems", async () => {
    const { postmortem, seen } = await write(inOrder(submit(unknownId), submit(unknownId), submit(unknownId)));
    assert.equal(seen.length, 3);
    assert.equal(postmortem.status, "failed");
    assert.match(postmortem.error!, /^Rejected: unknown evidence IDs cited: ev_nope\./);
  });
});
