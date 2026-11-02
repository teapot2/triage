import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Incident, Mitigation } from "../schema";
import { pullRequestBase } from "./pull-request";

const mitigation: Mitigation = {
  kind: "rollback",
  target: "9f3c2a1",
  branch: "shopfront-release/formatted-price",
  title: "Roll back shopfront to the deploy before 9f3c2a1",
  why: { text: "", evidenceIds: ["ev_commit_1"] },
  steps: [],
  undo: "",
  risk: "low",
  state: "applied",
  proposedAt: "2026-11-01T12:00:00.000Z",
};

const incident = (m?: Mitigation) => ({ id: "inc_test", mitigation: m }) as unknown as Incident;

describe("pullRequestBase", () => {
  it("targets the rolled-back release's branch", () => {
    assert.equal(pullRequestBase(incident(mitigation)), "shopfront-release/formatted-price");
  });

  it("leaves the default branch for a rollback with no branch, a flag, or no mitigation", () => {
    assert.equal(pullRequestBase(incident({ ...mitigation, branch: undefined })), undefined);
    assert.equal(pullRequestBase(incident({ ...mitigation, kind: "flag_off", target: "FF_LIST_PRICES" })), undefined);
    assert.equal(pullRequestBase(incident()), undefined);
  });
});
