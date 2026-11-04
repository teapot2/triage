import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { explainFailure, noReportError } from "./run-failure";
import type { Incident } from "./schema";
import { incidentHeadline, incidentPreview } from "./summary";

describe("noReportError", () => {
  it("tells running out of steps from a model that stopped early", () => {
    assert.equal(noReportError(30, 30), "No accepted report after 30 model steps");
    assert.equal(noReportError(3, 30), "The model stopped without submitting a report after 3 steps");
  });
});

describe("explainFailure", () => {
  it("titles each kind of failure", () => {
    assert.equal(explainFailure(noReportError(30, 30)).title, "The agent ran out of steps before finishing its report");
    assert.equal(explainFailure(noReportError(3, 30)).title, "The model stopped without submitting a report");
    assert.deepEqual(explainFailure("Meta's API is rate-limiting this key: HTTP 429 (4 tries)."), {
      title: "The model's API is rate-limiting this key",
      detail: "Meta's API is rate-limiting this key: HTTP 429 (4 tries).",
    });
    assert.equal(explainFailure("Meta's API answered HTTP 503 (4 tries).").title, "The model's API is overloaded");
    assert.equal(explainFailure("Investigation ran past its 10 min limit.").title, "The model didn't answer in time");
    assert.equal(explainFailure("Triage restarted while this ran").title, "The run stopped when Triage restarted");
    assert.deepEqual(explainFailure("Something odd"), { title: "The investigation failed", detail: "Something odd" });
  });
});

describe("a failed run in the lists", () => {
  const failed = {
    status: "failed",
    run: { source: "live", model: "m", startedAt: "2026-11-03T00:00:00.000Z", error: "Meta's API answered HTTP 503 (4 tries).\nmore" },
  } as Incident;

  it("reads as the failure's title, not the raw error", () => {
    assert.equal(incidentHeadline(failed), "The model's API is overloaded");
    assert.equal(incidentPreview(failed).takeaway, "The model's API is overloaded");
  });
});
