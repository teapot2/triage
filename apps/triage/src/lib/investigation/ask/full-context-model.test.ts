import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { closeDb } from "../../db";

// Which model a full-context answer runs on, from Settings' Ask stage. On a
// temp working directory so the settings in .data are ours; everything that
// touches .data is imported after the chdir.
const cwd = process.cwd();
const env = { ...process.env };
let dir: string;
let settings: typeof import("../../models/settings");
let pick: typeof import("./full-context-model");

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "triage-full-context-model-"));
  process.chdir(dir);
  process.env.MODEL_API_KEY = "test";
  process.env.BASETEN_API_KEY = "test";
  process.env.MODEL_ID = "muse-spark-1.3";
  settings = await import("../../models/settings");
  pick = await import("./full-context-model");
});
after(async () => {
  process.chdir(cwd);
  process.env = env;
  closeDb();
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

const ask = (provider: string, model: string) =>
  settings.updateModelSettings({ stages: { ask: { provider, model, effort: "low" } as never } });

describe("fullContextModel", () => {
  it("is Wonder on Meta's API while Ask is on Meta", async () => {
    await ask("meta", "muse-spark-1.3");
    const m = await pick.fullContextModel();
    assert.deepEqual(m && { provider: m.provider, model: m.model }, { provider: "meta", model: "muse-wonder-1.0" });
  });

  // An open-weights setup ("Open weights", "Built with Muse Spark Open")
  // shouldn't quietly call Meta's API for one feature.
  it("stays on the Ask stage's Spark Open, with its 1M window", async () => {
    await ask("baseten", "meta-models/muse-spark-open-1026");
    const m = await pick.fullContextModel();
    assert.deepEqual(m && { provider: m.provider, model: m.model }, { provider: "baseten", model: "meta-models/muse-spark-open-1026" });
  });

  it("falls back to Wonder for open weights whose window can't hold the bundle", async () => {
    await ask("openrouter", "meta/muse-glimmer-30b");
    const m = await pick.fullContextModel();
    assert.equal(m?.model, "muse-wonder-1.0");
  });
});
