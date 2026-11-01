import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callSettings, isTransientFailure, modelErrorText } from "./client";
import { ModelCallError } from "./fetch";
import { RunTimeoutError } from "./policy";

describe("modelErrorText", () => {
  it("keeps the retrying fetch's and the budget's sentences, wrapped or not", () => {
    const failed = new ModelCallError("Meta Model API answered HTTP 503 (4 tries).", 4, 503);
    assert.equal(modelErrorText(failed), "Meta Model API answered HTTP 503 (4 tries).");
    assert.equal(modelErrorText(new Error("Cannot connect to API", { cause: failed })), failed.message);
    assert.equal(modelErrorText(new RunTimeoutError("The answer ran past its 5-minute limit.")), "The answer ran past its 5-minute limit.");
  });

  it("puts the SDK's stream limits in words", () => {
    const first = new DOMException("First chunk timeout of 90000ms exceeded", "TimeoutError");
    assert.equal(modelErrorText(first, "meta"), "Meta Model API didn't start its answer within 90 s.");
    // As an abort part's reason.
    const chunk = new Error("TimeoutError: Chunk timeout of 60000ms exceeded");
    assert.equal(modelErrorText(chunk), "The model stopped sending its answer for 60 s.");
    assert.ok(isTransientFailure(first));
  });

  it("passes anything else through as its first line", () => {
    const refused = new Error("Invalid image\nstack…");
    assert.equal(modelErrorText(refused), "Invalid image");
    assert.equal(isTransientFailure(refused), false);
  });
});

describe("callSettings", () => {
  it("turns the SDK's retries off, and limits a stream's stalls", () => {
    assert.deepEqual(callSettings(), { maxRetries: 0 });
    assert.deepEqual(callSettings({ stream: true }), { maxRetries: 0, timeout: { chunkMs: 60_000 } });
  });
});
