import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cacheKey, modelOptions } from "./client";
import { modelLabel } from "./labels";
import { chosenModel } from "./settings";
import { effortsFor, recordedEffort } from "./stages";

describe("chosenModel", () => {
  it("gives each stage its default effort before anything is saved", () => {
    assert.equal(chosenModel({ stages: {} }, "investigate").effort, "high");
    assert.equal(chosenModel({ stages: {} }, "ask").effort, "low");
    assert.equal(chosenModel({ stages: {} }, "postmortem").effort, "medium");
  });

  it("takes the model down the fallback chain but keeps the stage's own effort", () => {
    const stages = { ask: { provider: "meta" as const, model: "muse-wonder-1.0", effort: "minimal" as const } };
    assert.deepEqual(chosenModel({ stages }, "postmortem"), { provider: "meta", model: "muse-wonder-1.0", effort: "medium" });
    assert.equal(chosenModel({ stages }, "ask").effort, "minimal");
  });
});

describe("modelOptions", () => {
  it("sends the effort to Meta's API", () => {
    assert.equal(modelOptions({ provider: "meta", effort: "xhigh" })?.openai.reasoningEffort, "xhigh");
  });

  it("leaves the effort out when there is none, and other providers alone", () => {
    assert.equal(modelOptions({ provider: "meta" })?.openai.reasoningEffort, undefined);
    assert.equal(modelOptions({ provider: "openrouter", effort: "high" }), undefined);
  });

  it("keys the prompt cache by stage and incident", () => {
    assert.equal(modelOptions({ provider: "meta" }, cacheKey("ask", "inc_1"))?.openai.promptCacheKey, "triage:ask:inc_1");
    assert.equal(modelOptions({ provider: "meta" })?.openai.promptCacheKey, undefined);
  });
});

describe("effortsFor", () => {
  it("offers Max on Spark 1.3 and Wonder but not older Sparks", () => {
    assert.ok(effortsFor("muse-spark-1.3").includes("max"));
    assert.ok(effortsFor("muse-wonder-1.0").includes("max"));
    assert.ok(!effortsFor("muse-spark-1.2").includes("max"));
    assert.ok(!effortsFor("muse-spark-1.1").includes("max"));
  });
});

describe("recordedEffort and modelLabel", () => {
  it("records an effort only for Meta's API", () => {
    assert.equal(recordedEffort({ provider: "meta", effort: "high" }), "high");
    assert.equal(recordedEffort({ provider: "fireworks", effort: "high" }), undefined);
  });

  it("names the effort after the provider", () => {
    assert.equal(modelLabel("muse-spark-1.3", "meta", "xhigh"), "muse-spark-1.3 via Meta Model API, extra high effort");
    assert.equal(modelLabel("muse-glimmer-30b", "openrouter"), "muse-glimmer-30b via OpenRouter");
  });
});
