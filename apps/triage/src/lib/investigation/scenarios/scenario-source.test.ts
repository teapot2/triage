import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createScenarioSource, getScenario } from ".";
import type { Scenario } from "./scenario-source";

// The scenario each flag fault plants, and the flag it turns on.
const planted: [string, string][] = [
  ["pool-leak", "FF_STOCK_DIRECT_QUERY"],
  ["price-gap", "FF_LIST_PRICES"],
  ["live-ratings", "FF_LIVE_RATINGS"],
];

const scenario = (id: string): Scenario => {
  const s = getScenario(id);
  assert.ok(s, `scenario ${id} exists`);
  return s;
};

describe("createScenarioSource flags", () => {
  for (const [id, flag] of planted) {
    it(`reports ${flag} on for ${id}`, async () => {
      const states = createScenarioSource(scenario(id)).describe().flags!;
      assert.equal(states[flag], true);
    });
  }

  it("reports no flag on for bad-deploy, whose only flip went off again", async () => {
    const states = createScenarioSource(scenario("bad-deploy")).describe().flags!;
    assert.deepEqual(Object.values(states).filter(Boolean), []);
    assert.equal(states.FF_LIST_PRICES, false);
  });

  it("starts from the boot line and applies the flips since it, by time", async () => {
    const base = scenario("pool-leak");
    const s: Scenario = {
      ...base,
      now: "2026-11-02T08:00:00.000Z",
      logs: [
        {
          service: "shopfront",
          level: "info",
          message: 'flags: loaded {"flag.FF_STOCK_DIRECT_QUERY":false,"flag.FF_LIST_PRICES":true,"flag.FF_LIVE_RATINGS":false}',
          count: 1,
          firstSeen: "2026-11-02T07:00:00.000Z",
          lastSeen: "2026-11-02T07:00:00.000Z",
        },
        {
          service: "shopfront",
          level: "warn",
          message: 'ops: FF_LIST_PRICES turned off {"flag.name":"FF_LIST_PRICES"}',
          count: 1,
          firstSeen: "2026-11-02T07:30:00.000Z",
          lastSeen: "2026-11-02T07:30:00.000Z",
        },
        // Turned on before the boot: the boot line's state wins.
        {
          service: "shopfront",
          level: "warn",
          message: 'ops: FF_LIVE_RATINGS turned on {"flag.name":"FF_LIVE_RATINGS"}',
          count: 1,
          firstSeen: "2026-11-02T06:00:00.000Z",
          lastSeen: "2026-11-02T06:00:00.000Z",
        },
      ],
      deploys: [
        {
          service: "shopfront",
          sha: "config:FF_STOCK_DIRECT_QUERY",
          kind: "config",
          message: "ops: FF_STOCK_DIRECT_QUERY turned on",
          deployedAt: "2026-11-02T07:45:00.000Z",
        },
      ],
    };
    assert.deepEqual(createScenarioSource(s).describe().flags, {
      FF_STOCK_DIRECT_QUERY: true,
      FF_LIST_PRICES: false,
      FF_LIVE_RATINGS: false,
    });
  });

  it("leaves a flag no log mentions out", async () => {
    const s: Scenario = { ...scenario("pool-leak"), logs: [], deploys: [] };
    assert.deepEqual(createScenarioSource(s).describe().flags, {});
  });
});
