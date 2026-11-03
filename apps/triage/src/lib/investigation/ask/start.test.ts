import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { closeDb } from "../../db";
import { resolved } from "../postmortem/test-incidents";

// Which model a question starts on: the composer's choice when it sends
// one, else Settings' Ask model. On a temp working directory so .data is
// ours; the store resolves its folder when it loads, so everything that
// touches .data is imported after the chdir.
const cwd = process.cwd();
const env = { ...process.env };
let dir: string;
let store: typeof import("../store");
let start: typeof import("./start");

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "triage-ask-start-"));
  process.chdir(dir);
  process.env.MODEL_API_KEY = "test";
  process.env.MODEL_ID = "muse-spark-1.3";
  delete process.env.OPENROUTER_API_KEY;
  store = await import("../store");
  start = await import("./start");
});
after(async () => {
  process.chdir(cwd);
  process.env = env;
  closeDb();
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

async function saved(id: string) {
  await store.saveIncident({ ...resolved(), id });
}

describe("startQuestion's model", () => {
  it("is Settings' Ask model without a choice", async () => {
    await saved("inc_settings");
    const started = await start.startQuestion("inc_settings", "why?");
    assert.ok(started.ok);
    assert.equal(started.stage.model, "muse-spark-1.3");
    assert.equal(started.question.model, "muse-spark-1.3");
    assert.equal(started.question.reasoningEffort, "low");
  });

  it("is the composer's choice, effort and all, on the question and the stage", async () => {
    await saved("inc_choice");
    const started = await start.startQuestion("inc_choice", "why?", {
      model: { provider: "meta", model: "muse-wonder-1.0", effort: "high" },
    });
    assert.ok(started.ok);
    assert.deepEqual(
      [started.stage.provider, started.stage.model, started.stage.effort],
      ["meta", "muse-wonder-1.0", "high"],
    );
    assert.equal(started.question.model, "muse-wonder-1.0");
    assert.equal(started.question.reasoningEffort, "high");
    // Settings is left as it was.
    await saved("inc_after");
    const next = await start.startQuestion("inc_after", "and now?");
    assert.ok(next.ok);
    assert.equal(next.question.model, "muse-spark-1.3");
  });

  it("refuses a chosen provider that can't run, before appending the question", async () => {
    await saved("inc_nokey");
    const started = await start.startQuestion("inc_nokey", "why?", {
      model: { provider: "openrouter", model: "meta/muse-glimmer-30b" },
    });
    assert.deepEqual(started, {
      ok: false,
      status: 409,
      error: "OPENROUTER_API_KEY is not set. Add it to apps/triage/.env.local and restart.",
    });
    assert.equal((await store.getIncident("inc_nokey"))?.questions?.length ?? 0, 0);
  });

  it("is refused by the route for a provider Triage doesn't know", async () => {
    const { POST } = await import("../../../app/api/incidents/[id]/questions/route");
    const res = await POST(
      new Request("http://localhost/api/incidents/inc_choice/questions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "why?", model: { provider: "acme", model: "x" } }),
      }),
      { params: Promise.resolve({ id: "inc_choice" }) },
    );
    assert.equal(res.status, 400);
  });
});
