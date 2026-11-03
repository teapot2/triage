import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { closeDb } from "../db";
import { mitigated, poolLeak } from "./postmortem/test-incidents";
import { InvestigationRecorder, QuestionRecorder, questionEvidencePrefix } from "./recorder";
import type { Incident, Question } from "./schema";

function question(id: string): Question {
  return {
    id,
    text: "Why not the cache?",
    askedAt: "2026-10-23T03:00:00Z",
    status: "answering",
    answer: "",
    citedIds: [],
    unknownIds: [],
    steps: [],
    evidence: [],
    mode: "tools",
    model: "muse-spark-1.3",
  };
}

// A recorder whose saves are collected instead of written.
function recorder(id: string) {
  const saved: Question[] = [];
  const r = new QuestionRecorder(question(id), "inc_test", "shopfront", async (_, q) => {
    saved.push(q);
  });
  return { r, saved };
}

const log = { kind: "log" as const, summary: "3x error", service: "shopfront", level: "error" as const, message: "boom" };

describe("QuestionRecorder", () => {
  it("prefixes evidence IDs with the question's ID", () => {
    assert.equal(questionEvidencePrefix("q_2"), "ev_q2_");
    assert.equal(questionEvidencePrefix("q_12"), "ev_q12_");
    const { r } = recorder("q_2");
    r.startStep("call_1", "query_logs", {});
    const evidence = r.completeStep("call_1", "query_logs", "2 log groups", [log, log]);
    r.startStep("call_2", "query_logs", {});
    const more = r.completeStep("call_2", "query_logs", "1 log group", [log]);
    assert.deepEqual(
      [...evidence, ...more].map((e) => e.id),
      ["ev_q2_log_1", "ev_q2_log_2", "ev_q2_log_3"],
    );
    assert.deepEqual(r.question.steps.map((s) => [s.status, s.evidenceIds]), [
      ["completed", ["ev_q2_log_1", "ev_q2_log_2"]],
      ["completed", ["ev_q2_log_3"]],
    ]);
    assert.equal(r.question.evidence.length, 3);
    return r.flush();
  });

  it("matches the investigation's evidence ID format", () => {
    const { r } = recorder("q_1");
    r.startStep("call_1", "query_logs", {});
    const [e] = r.completeStep("call_1", "query_logs", "1 log group", [log]);
    assert.match(e.id, /^ev_[a-z0-9_]+$/);
    return r.flush();
  });

  it("marks each step with the model call that asked for it, even when its thought is dropped", () => {
    const { r } = recorder("q_1");
    r.startStep("call_0", "query_logs", {});
    r.startThought("th_a");
    r.endThought("th_a", { text: "Logs and traces at once." });
    r.startStep("call_1", "query_logs", {});
    r.startStep("call_2", "query_traces", {});
    // An empty thought goes, but its calls still belong to it.
    r.startThought("th_b");
    r.endThought("th_b", {});
    r.startStep("call_3", "deploy_history", {});
    assert.deepEqual(r.question.thoughts?.map((t) => t.id), ["th_a"]);
    assert.deepEqual(r.question.steps.map((s) => [s.id, s.turn]), [
      ["call_0", undefined],
      ["call_1", "th_a"],
      ["call_2", "th_a"],
      ["call_3", "th_b"],
    ]);
    return r.flush();
  });

  it("batches saves while the answer streams, and flush writes the last state", async () => {
    const { r, saved } = recorder("q_1");
    for (const t of ["The pool ", "leaks ", "[ev_log_1]."]) r.appendAnswer(t);
    assert.equal(saved.length, 0);
    await r.flush();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].answer, "The pool leaks [ev_log_1].");
    // Saved as a copy: later changes don't reach what was written.
    r.update({ status: "answered" });
    assert.equal(saved[0].status, "answering");
    await r.flush();
    assert.equal(saved.at(-1)?.status, "answered");
  });
});

// The investigation's recorder saving into the store, on a temp working
// directory so .data (and the database in it) is its own.
describe("InvestigationRecorder in the store", () => {
  const cwd = process.cwd();
  let dir: string;
  let store: typeof import("./store");
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "triage-recorder-"));
    process.chdir(dir);
    store = await import("./store");
  });
  after(async () => {
    // Windows won't delete the temp directory while the database is open.
    closeDb();
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  // An incident whose investigation has just started.
  async function started(id: string): Promise<Incident> {
    const incident: Incident = {
      ...poolLeak(),
      id,
      status: "investigating",
      steps: [],
      evidence: [],
      thoughts: undefined,
      report: undefined,
      mitigation: undefined,
      fixRun: undefined,
      fix: undefined,
      approval: undefined,
      postmortem: undefined,
    };
    await store.saveIncident(incident);
    return structuredClone(incident);
  }

  it("saves its own fields and leaves what others wrote meanwhile", async () => {
    const r = new InvestigationRecorder(await started("inc_rec_own"));
    r.startStep("call_1", "query_logs", {});
    await r.flush();
    // The Slack card and an archive land while the run goes on.
    await store.patchIncident("inc_rec_own", (i) => ({ ...i, slack: { channel: "C1", ts: "1.2" }, archivedAt: "2026-11-02T10:00:00.000Z" }));
    r.completeStep("call_1", "query_logs", "1 log group", [log]);
    r.update({ status: "diagnosed", report: poolLeak().report });
    await r.flush();

    const stored = (await store.getIncident("inc_rec_own"))!;
    assert.deepEqual(stored.slack, { channel: "C1", ts: "1.2" });
    assert.equal(stored.archivedAt, "2026-11-02T10:00:00.000Z");
    assert.equal(stored.status, "diagnosed");
    assert.ok(stored.report);
    assert.deepEqual(stored.steps.map((s) => s.status), ["completed"]);
    assert.deepEqual(stored.evidence.map((e) => e.id), ["ev_log_1"]);
  });

  it("keeps a resolved incident resolved and a decided mitigation as decided", async () => {
    const r = new InvestigationRecorder(await started("inc_rec_kept"));
    const proposed = { ...mitigated().mitigation!, state: "proposed" as const, decidedAt: undefined, appliedAt: undefined, recovery: undefined };
    r.update({ status: "diagnosed", mitigation: proposed });
    await r.flush();
    assert.equal((await store.getIncident("inc_rec_kept"))?.mitigation?.state, "proposed");

    // Approved and resolved while the fix stage still runs here.
    await store.patchIncident("inc_rec_kept", (i) => ({
      ...i,
      status: "resolved",
      resolvedAt: "2026-11-02T10:00:00.000Z",
      mitigation: { ...i.mitigation!, state: "approved" },
    }));
    r.update({ fixRun: { status: "failed", attempt: 1, startedAt: "2026-11-02T09:59:00.000Z", error: "no fix" } });
    await r.flush();

    const stored = (await store.getIncident("inc_rec_kept"))!;
    assert.equal(stored.status, "resolved");
    assert.equal(stored.resolvedAt, "2026-11-02T10:00:00.000Z");
    assert.equal(stored.mitigation?.state, "approved");
    assert.equal(stored.fixRun?.status, "failed");
  });
});
