import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultRules } from "../../lib/investigation/watch-rule-model";
import { defaultRuleSort, filterRules, parseRuleSort, ruleSorts, ruleStatuses } from "./rule-filters";

const names = (sort: Parameters<typeof filterRules>[1]["sort"]) =>
  filterRules(defaultRules, { query: "", facets: {}, sort }, () => "ok").map((r) => r.name);

describe("rule sorts", () => {
  it("lists the active rules before the paused ones by default, each by name", () => {
    assert.equal(parseRuleSort(null), defaultRuleSort);
    assert.deepEqual(names(defaultRuleSort), ["API SLO", "Page latency", "Server errors", "API latency"]);
  });

  it("names the default first in the sort menu", () => {
    assert.equal(ruleSorts[0].id, defaultRuleSort);
    assert.equal(ruleSorts[0].label, "Active first");
  });

  it("still sorts by name alone when asked", () => {
    assert.equal(parseRuleSort("name"), "name");
    assert.deepEqual(names("name"), ["API latency", "API SLO", "Page latency", "Server errors"]);
  });
});

describe("rule statuses", () => {
  // Idle is under the rule's minimum of requests, not necessarily none.
  it("calls an idle rule's status too little traffic", () => {
    assert.equal(ruleStatuses.find((s) => s.id === "idle")?.label, "Too little traffic");
  });
});
