import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { notRecoveredWhy } from "./mitigation-card";

describe("notRecoveredWhy", () => {
  it("says how long the watch ran, not a fixed 5 min", () => {
    assert.equal(notRecoveredWhy(undefined, 5 * 60_000 + 1_000), "still past the limit after 5 min");
    assert.equal(notRecoveredWhy(undefined, 10 * 60_000 + 15_000), "still past the limit after 10 min");
  });

  it("leaves the time out when it isn't known", () => {
    assert.equal(notRecoveredWhy(undefined), "still past the limit");
  });

  it("keeps the note's own reason when there is one", () => {
    assert.equal(notRecoveredWhy("No requests to judge since the mitigation", 10 * 60_000), "no requests since the mitigation");
  });
});
