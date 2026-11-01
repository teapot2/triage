import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { investigationTrace, traceRows } from "../export/datasets/incident";
import { fanoutIncident, fanoutIncidentRunning } from "./fanout-fixture";
import { exampleIncidents } from "./fixtures";
import { findUnknownEvidenceIds } from "./schema";

describe("fan-out fixture", () => {
  it("stays out of the example incidents", () => {
    const ids = exampleIncidents.map((i) => i.id);
    assert.ok(!ids.includes(fanoutIncident.id));
    assert.ok(!ids.includes(fanoutIncidentRunning.id));
  });

  it("cites only evidence it has, lane evidence included", () => {
    for (const incident of [fanoutIncident, fanoutIncidentRunning]) {
      const known = new Set(incident.evidence.map((e) => e.id));
      const cited = [
        ...incident.steps.flatMap((s) => s.evidenceIds),
        ...incident.run!.fanout!.hypotheses.flatMap((h) => [...h.evidenceFor, ...h.evidenceAgainst]),
        ...(incident.mitigation?.why.evidenceIds ?? []),
      ];
      assert.deepEqual(cited.filter((id) => !known.has(id)), [], incident.id);
    }
    assert.deepEqual(findUnknownEvidenceIds(fanoutIncident.report!, fanoutIncident.evidence), []);
    assert.ok(fanoutIncident.evidence.some((e) => e.id === "ev_h1_log_1"));
  });

  it("has a supported, a refuted and an unclear hypothesis, and one still checking mid-run", () => {
    assert.deepEqual(fanoutIncident.run!.fanout!.hypotheses.map((h) => h.finding), ["supported", "refuted", "unclear"]);
    assert.deepEqual(fanoutIncidentRunning.run!.fanout!.hypotheses.map((h) => h.finding), ["supported", "refuted", undefined]);
  });

  it("puts each row's lane in the trace export", () => {
    const rows = traceRows(fanoutIncident).map((r) => investigationTrace.json!(r) as Record<string, unknown>);
    assert.equal(rows[0].kind, "run");
    assert.equal(rows[0].lane, null);
    assert.deepEqual(
      [...new Set(rows.slice(1).map((r) => r.lane))],
      ["scout", "h1", "h2", "h3", "merge"],
    );
    const step = rows.find((r) => r.id === "step_h1_5")!;
    assert.deepEqual({ lane: step.lane, evidence_ids: step.evidence_ids }, { lane: "h1", evidence_ids: ["ev_h1_log_1"] });
  });
});
