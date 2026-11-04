import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exampleIncidents } from "../fixtures";
import type { Incident } from "../schema";
import type { OpsState } from "./executors";
import { holds, mitigationInEffect } from "./in-effect";

const flags = (on: string[] = []): OpsState["flags"] =>
  ["FF_STOCK_DIRECT_QUERY", "FF_LIST_PRICES"].map((name) => ({ name, enabled: on.includes(name) }));

describe("holds", () => {
  const flagOff = { kind: "flag_off" as const, target: "FF_STOCK_DIRECT_QUERY" };
  const rollback = { kind: "rollback" as const, target: "a1b9c4e" };

  it("holds a flag_off while its flag is off, another fault's flag on or not", () => {
    assert.equal(holds(flagOff, { flags: flags(), release: null }), true);
    assert.equal(holds(flagOff, { flags: flags(["FF_LIST_PRICES"]), release: null }), true);
  });

  it("doesn't once the flag is back on", () => {
    assert.equal(holds(flagOff, { flags: flags(["FF_STOCK_DIRECT_QUERY"]), release: null }), false);
  });

  it("can't say for a flag the store doesn't list", () => {
    assert.equal(holds({ kind: "flag_off", target: "FF_GONE" }, { flags: flags(), release: null }), undefined);
  });

  it("holds a rollback while its release isn't deployed again", () => {
    assert.equal(holds(rollback, { flags: flags(), release: null }), true);
    // Another release is a change of its own, not the rolled-back one back.
    assert.equal(holds(rollback, { flags: flags(), release: { sha: "77de01f" } }), true);
  });

  it("doesn't once the same release is deployed again, short or full sha", () => {
    assert.equal(holds(rollback, { flags: flags(), release: { sha: "a1b9c4e" } }), false);
    assert.equal(holds(rollback, { flags: flags(), release: { sha: "A1B9C4E0d3f2" } }), false);
    assert.equal(holds({ kind: "rollback", target: "a1b9c4e0d3f2" }, { flags: flags(), release: { sha: "a1b9c4e" } }), false);
  });

  it("can't say for a rollback when the store doesn't report its release", () => {
    assert.equal(holds(rollback, { flags: flags() }), undefined);
  });
});

describe("mitigationInEffect", () => {
  const base = structuredClone(exampleIncidents[0]);
  const withMitigation = (state: NonNullable<Incident["mitigation"]>["state"] | undefined): Incident => ({
    ...base,
    mitigation: state && {
      kind: "flag_off",
      target: "FF_STOCK_DIRECT_QUERY",
      title: "Turn off FF_STOCK_DIRECT_QUERY",
      why: { text: "x", evidenceIds: ["ev_log_1"] },
      steps: [],
      undo: "Turn it back on",
      risk: "low",
      state,
      proposedAt: base.detectedAt,
    },
  });

  it("is false without an applied mitigation, without asking the service", async () => {
    for (const state of [undefined, "proposed", "denied", "failed"] as const) {
      assert.equal(await mitigationInEffect(withMitigation(state)), false);
    }
  });

  it("can't say for an applied one on a run with no live service", async () => {
    // A bundled example's run is simulated: nothing to read.
    assert.equal(await mitigationInEffect(withMitigation("applied")), undefined);
  });
});
