import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contextLimit, contextShare, fullestContext } from "./context";
import { fuller } from "./usage";

const call = (inputTokens: number) => ({ inputTokens, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 });

describe("contextLimit", () => {
  it("knows Meta's API, OpenRouter's and Baseten's models, and nothing else", () => {
    assert.equal(contextLimit("meta", "muse-spark-1.3"), 1_048_576);
    assert.equal(contextLimit("openrouter", "meta/muse-glimmer-30b"), 131_072);
    assert.equal(contextLimit("baseten", "meta-models/muse-spark-open-1026"), 1_048_576);
    assert.equal(contextLimit("baseten", "some-other-model"), undefined);
    // The same weights elsewhere run with whatever context they were given.
    assert.equal(contextLimit("modal", "muse-glimmer-30b"), undefined);
    assert.equal(contextLimit("ollama", "muse-glimmer:30b"), undefined);
    assert.equal(contextLimit(undefined, "muse-spark-1.3"), undefined);
  });
});

describe("contextShare", () => {
  it("is the fullest call's input against the window, once there is one", () => {
    assert.equal(contextShare({ provider: "openrouter", model: "meta/muse-glimmer-30b", context: call(65_536) }), 0.5);
    assert.equal(contextShare({ provider: "openrouter", model: "meta/muse-glimmer-30b" }), undefined);
    assert.equal(contextShare({ provider: "custom", model: "x", context: call(1) }), undefined);
  });
});

describe("fullestContext", () => {
  it("compares records by share, each against its own model", () => {
    const glimmer = { provider: "openrouter", model: "meta/muse-glimmer-30b", context: call(13_107) };
    const spark = { provider: "meta", model: "muse-spark-1.3", context: call(100_000) };
    const unknown = { provider: "modal", model: "muse-glimmer-30b", context: call(60_000) };
    assert.equal(fullestContext([spark, glimmer, unknown]), glimmer);
    assert.equal(fullestContext([unknown]), undefined);
  });
});

describe("fuller", () => {
  it("keeps the call with more input", () => {
    assert.deepEqual(fuller(call(5), call(3)), call(5));
    assert.deepEqual(fuller(call(3), call(5)), call(5));
    assert.deepEqual(fuller(undefined, call(1)), call(1));
  });
});
