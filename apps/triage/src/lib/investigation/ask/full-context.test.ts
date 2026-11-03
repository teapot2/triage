import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { poolLeak } from "../postmortem/test-incidents";
import { getScenario } from "../scenarios";
import { createScenarioSource } from "../scenarios/scenario-source";
import { evidenceSchema } from "../schema";
import { buildContext, bundleText, estimateTokens } from "./full-context";

const incident = poolLeak();
const source = () => createScenarioSource(getScenario("pool-leak")!);
const others = [
  { ...poolLeak(), id: "inc_b", title: "Second", detectedAt: "2026-10-02T10:00:00.000Z" },
  { ...poolLeak(), id: "inc_a", title: "First", detectedAt: "2026-10-01T10:00:00.000Z" },
  { ...poolLeak(), id: "inc_other_service", service: "billing", detectedAt: "2026-10-01T09:00:00.000Z" },
  incident,
];

describe("buildContext", () => {
  it("gives the same bundle for the same incident", async () => {
    const a = await buildContext(incident, source(), others, 200_000);
    const b = await buildContext(incident, source(), [...others].reverse(), 200_000);
    assert.equal(bundleText(a.parts), bundleText(b.parts));
    assert.deepEqual([...a.items.keys()], [...b.items.keys()]);
  });

  it("gives every item a valid evidence record under its ID", async () => {
    const { items } = await buildContext(incident, source(), others, 200_000);
    assert.ok(items.size > 0);
    for (const [id, e] of items) {
      assert.equal(e.id, id);
      assert.match(id, /^ev_ctx_(source|commit|incident|metric|log|span)_[a-z0-9_]+$/);
      evidenceSchema.parse(e);
    }
  });

  it("puts in the service's earlier incidents, oldest first, never this one", async () => {
    const { parts, items } = await buildContext(incident, source(), others, 200_000);
    const cited = [...items.values()].filter((e) => e.kind === "incident");
    assert.deepEqual(
      cited.map((e) => e.kind === "incident" && e.incidentId),
      ["inc_a", "inc_b"],
    );
    assert.ok(parts.incidents.indexOf("ev_ctx_incident_1 · First") < parts.incidents.indexOf("ev_ctx_incident_2 · Second"));
    // Their own evidence IDs would mean nothing here.
    assert.doesNotMatch(parts.incidents, /\[ev_/);
  });

  it("cuts the telemetry to the budget", async () => {
    const roomy = await buildContext(incident, source(), others, 500_000);
    const fixed = estimateTokens(roomy.parts.source + roomy.parts.changes + roomy.parts.incidents);
    const tight = await buildContext(incident, source(), others, fixed + 300);
    assert.ok(estimateTokens(bundleText(tight.parts)) <= fixed + 300 + 50);
    assert.ok(tight.parts.telemetry.length < roomy.parts.telemetry.length);
    assert.ok(tight.spans.included <= roomy.spans.included);
  });
});
