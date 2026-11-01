import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InvestigationStep, Thought } from "../../lib/investigation/schema";
import { emptyFilters, facetOptions, filterSteps, filterThoughts, kindOf } from "./log-filters";

const at = new Date(Date.UTC(2026, 9, 31, 12)).toISOString();
const thought = (id: string, text: string, lane?: string): Thought => ({ id, startedAt: at, text, ...(lane && { lane }) });
const step = (id: string, lane?: string, status: InvestigationStep["status"] = "completed"): InvestigationStep => ({
  id,
  tool: "query_logs",
  input: {},
  status,
  startedAt: at,
  evidenceIds: [`ev_${lane ? `${lane}_` : ""}log_${id}`],
  ...(lane && { lane }),
});

const thoughts = [thought("t1", "Check the pool", "h1"), thought("t2", "Check the queries", "h2"), thought("t3", "Merge", "merge")];

describe("kindOf", () => {
  it("reads the kind past a question's or a lane's prefix", () => {
    assert.deepEqual(["ev_log_3", "ev_metric_p95", "ev_q2_span_1", "ev_h1_log_1"].map(kindOf), ["log", "metric", "span", "log"]);
  });
});

describe("lane filter", () => {
  it("keeps the tool calls of the lanes picked", () => {
    const steps = [step("1", "h1"), step("2", "h2"), step("3", "h1")];
    const shown = filterSteps(steps, "", { ...emptyFilters, lane: ["h1"] }, new Map());
    assert.deepEqual(shown.map((s) => s.id), ["1", "3"]);
  });

  it("keeps the thoughts of the lanes picked too", () => {
    const shown = filterThoughts(thoughts, "", { ...emptyFilters, lane: ["h2", "merge"] });
    assert.deepEqual(shown.map((t) => t.id), ["t2", "t3"]);
  });

  it("still lets a tool-call filter hide thoughts, unless Type asks for them", () => {
    const errors = { ...emptyFilters, lane: ["h1"], status: ["error"] };
    assert.deepEqual(filterThoughts(thoughts, "", errors), []);
    assert.deepEqual(filterThoughts(thoughts, "", { ...errors, kind: ["thought"] }).map((t) => t.id), ["t1"]);
  });

  it("narrows thoughts by a search as before", () => {
    assert.deepEqual(filterThoughts(thoughts, "queries", emptyFilters).map((t) => t.id), ["t2"]);
  });

  it("groups a lane's evidence under its kind", () => {
    assert.deepEqual(facetOptions([step("1", "h1"), step("2")], "evidence"), [{ value: "log", count: 2 }]);
  });
});
