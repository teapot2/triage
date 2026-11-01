import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Fanout, InvestigationStep, Thought } from "../../lib/investigation/schema";
import { compareLanes, laneLabel, laneOfHypothesis, laneOptions, laneTitle } from "./lanes";

const at = new Date(Date.UTC(2026, 9, 31, 12)).toISOString();
const thought = (id: string, lane?: string): Thought => ({ id, startedAt: at, ...(lane && { lane }) });
const step = (id: string, lane?: string): InvestigationStep => ({
  id,
  tool: "query_logs",
  input: {},
  status: "completed",
  startedAt: at,
  evidenceIds: [],
  ...(lane && { lane }),
});

const hypothesis = (id: string, title: string) => ({ id, title, claim: title, evidenceFor: [], evidenceAgainst: [] });
const fanout: Fanout = {
  leadModel: "muse-spark-1.3",
  hypotheses: [hypothesis("h1", "Connection leak"), hypothesis("h2", "Slow query"), hypothesis("h3", "Traffic spike")],
};

describe("laneLabel", () => {
  it("names the scout, each hypothesis's lane and the merge", () => {
    assert.deepEqual(["scout", "h1", "h3", "merge"].map(laneLabel), ["Scout", "H1", "H3", "Merge"]);
  });

  it("shows a lane it doesn't know as recorded", () => {
    assert.equal(laneLabel("verify"), "verify");
  });
});

describe("laneTitle", () => {
  it("names the hypothesis a lane checked", () => {
    assert.equal(laneTitle("h2", fanout), "H2: Slow query");
  });

  it("falls back to the lane's number when hypotheses have other IDs", () => {
    const other = { ...fanout, hypotheses: fanout.hypotheses.map((h, i) => ({ ...h, id: `hyp_${i}` })) };
    assert.equal(laneTitle("h3", other), "H3: Traffic spike");
    assert.equal(laneOfHypothesis(other, 2), "h3");
  });

  it("says what the lead model's lanes do, and nothing for an unknown hypothesis", () => {
    assert.match(laneTitle("scout")!, /proposes/);
    assert.match(laneTitle("merge", fanout)!, /report/);
    assert.equal(laneTitle("h1"), undefined);
    assert.equal(laneTitle("h9", fanout), undefined);
  });
});

describe("laneOptions", () => {
  it("counts thoughts and tool calls per lane, scout first, merge last", () => {
    const thoughts = [thought("t1", "merge"), thought("t2", "h2"), thought("t3", "scout"), thought("t4", "h1")];
    const steps = [step("s1", "h2"), step("s2", "h10"), step("s3", "h1"), step("s4", "h2"), step("s5", "scout")];
    assert.deepEqual(laneOptions(steps, thoughts), [
      { value: "scout", count: 2 },
      { value: "h1", count: 2 },
      { value: "h2", count: 3 },
      { value: "h10", count: 1 },
      { value: "merge", count: 1 },
    ]);
  });

  it("is empty for a single-agent run", () => {
    assert.deepEqual(laneOptions([step("s1")], [thought("t1")]), []);
  });

  it("orders unknown lanes after the merge", () => {
    assert.deepEqual(["verify", "merge", "h1"].sort(compareLanes), ["h1", "merge", "verify"]);
  });
});
