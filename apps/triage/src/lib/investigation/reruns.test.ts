import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exampleIncidents } from "./fixtures";
import { RETENTION_MS } from "./live/otlp-files";
import { recovered } from "./recover";
import {
  allRuns,
  currentRun,
  LIVE_RETENTION_MS,
  otherRuns,
  promote,
  promoteBlocker,
  rerunBlocker,
  runModelsOf,
  runView,
} from "./reruns";
import { type Incident, incidentSchema, type Rerun } from "./schema";

const detectedAt = "2026-11-02T10:00:00.000Z";

// The pool-leak example as a finished recorded-scenario run, diagnosed,
// with its fix waiting for approval and nothing acted on yet.
function scenarioIncident(): Incident {
  const example = structuredClone(exampleIncidents.find((i) => i.id === "inc_pool_leak")!);
  return {
    ...example,
    id: "inc_test_rerun",
    status: "diagnosed",
    detectedAt,
    approval: undefined,
    verification: undefined,
    resolvedAt: undefined,
    mitigation: example.mitigation && { ...example.mitigation, state: "proposed" },
    run: { ...example.run!, source: "scenario:pool-leak", provider: "meta", model: "muse-spark-1.3", reasoningEffort: "high", startedAt: detectedAt },
    questions: [],
  };
}

// A finished re-run of `incident` on Glimmer, healthy where the first run
// found a root cause.
function rerunOf(incident: Incident, patch: Partial<Rerun> = {}): Rerun {
  return {
    number: 2,
    status: "healthy",
    steps: [],
    thoughts: [],
    evidence: [],
    report: { ...incident.report!, verdict: { kind: "healthy", rationale: { text: "Nothing is wrong", evidenceIds: [incident.evidence[0].id] } } },
    run: { source: incident.run!.source, provider: "openrouter", model: "muse-glimmer-30b", startedAt: detectedAt, finishedAt: detectedAt },
    models: { investigate: { provider: "openrouter", model: "muse-glimmer-30b" } },
    ...patch,
  };
}

describe("runs", () => {
  it("counts the incident's own run as run 1 until a re-run is promoted", () => {
    const incident = { ...scenarioIncident(), reruns: [rerunOf(scenarioIncident())] };
    assert.equal(currentRun(incident), 1);
    assert.deepEqual(
      allRuns(incident).map((r) => r.number),
      [1, 2],
    );
    assert.deepEqual(
      otherRuns(incident).map((r) => r.number),
      [2],
    );
  });

  it("shows another run without the incident's questions or resolution", () => {
    const base = scenarioIncident();
    const incident: Incident = {
      ...base,
      questions: [structuredClone(exampleIncidents.find((i) => i.questions?.length)?.questions?.[0])].filter((q) => q !== undefined),
      reruns: [rerunOf(base)],
    };
    const view = runView(incident, 2)!;
    assert.equal(view.status, "healthy");
    assert.equal(view.run?.model, "muse-glimmer-30b");
    assert.equal(view.questions, undefined);
    assert.equal(view.id, incident.id);
    assert.equal(runView(incident, 1), incident);
    assert.equal(runView(incident, 7), undefined);
  });
});

describe("promote", () => {
  it("swaps the run in and keeps the one it replaces", () => {
    const base = scenarioIncident();
    const incident: Incident = { ...base, reruns: [rerunOf(base)] };
    const next = promote(incident, 2);
    assert.equal(next.runNumber, 2);
    assert.equal(next.status, "healthy");
    assert.equal(next.run?.model, "muse-glimmer-30b");
    assert.deepEqual(next.models, { investigate: { provider: "openrouter", model: "muse-glimmer-30b" } });
    // The first run is among the others now, whole.
    const first = next.reruns!.find((r) => r.number === 1)!;
    assert.equal(first.status, "diagnosed");
    assert.equal(first.run?.model, "muse-spark-1.3");
    assert.deepEqual(first.steps, base.steps);
    assert.deepEqual(first.mitigation, base.mitigation);
    // A run the re-run never had (no fix) leaves the incident without one.
    assert.equal(next.fix, undefined);
    // Still a valid incident, and promoting back restores the first run.
    incidentSchema.parse(next);
    const back = promote(next, 1);
    assert.equal(back.runNumber, 1);
    assert.equal(back.run?.model, "muse-spark-1.3");
    assert.deepEqual(back.fix, base.fix);
  });

  it("refuses while the re-run runs, without a diagnosis, or once the incident acted", () => {
    const base = scenarioIncident();
    const with2 = (patch: Partial<Rerun>, incident = base): Incident => ({ ...incident, reruns: [rerunOf(base, patch)] });
    assert.equal(promoteBlocker(with2({}), 2), undefined);
    assert.match(promoteBlocker(with2({ status: "investigating" }), 2)!, /still running/);
    assert.match(promoteBlocker(with2({ status: "failed", report: undefined }), 2)!, /no diagnosis/);
    assert.match(promoteBlocker(with2({}), 1)!, /already/);
    assert.match(promoteBlocker(with2({}), 5)!, /no run 5/);
    const approved = { ...base, mitigation: { ...base.mitigation!, state: "applied" as const } };
    assert.match(promoteBlocker(with2({}, approved), 2)!, /mitigation was approved/);
    const resolved = { ...base, status: "resolved" as const };
    assert.match(promoteBlocker(with2({}, resolved), 2)!, /resolved/);
  });
});

describe("rerunBlocker", () => {
  const now = Date.parse(detectedAt) + 60 * 60_000;

  it("lets a finished scenario run again", () => {
    assert.equal(rerunBlocker(scenarioIncident(), now), undefined);
  });

  it("turns down bundled examples and runs still going", () => {
    assert.match(rerunBlocker({ ...scenarioIncident(), run: undefined }, now)!, /Bundled examples/);
    assert.match(rerunBlocker({ ...scenarioIncident(), status: "investigating" }, now)!, /Wait/);
  });

  it("needs a live run's snapshot and its telemetry still kept", () => {
    const live: Incident = { ...scenarioIncident(), run: { ...scenarioIncident().run!, source: "live:shopfront" } };
    assert.match(rerunBlocker(live, now)!, /from before Triage saved/);
    const snapped = { ...live, snapshot: { takenAt: detectedAt, gitFrom: "abc1234" } };
    assert.equal(rerunBlocker(snapped, now), undefined);
    assert.match(rerunBlocker(snapped, Date.parse(detectedAt) + LIVE_RETENTION_MS)!, /rolled out/);
  });

  it("keeps the collector's retention", () => {
    assert.equal(LIVE_RETENTION_MS, RETENTION_MS);
  });
});

describe("runModelsOf", () => {
  it("reads a first run's models from its records", () => {
    const incident = scenarioIncident();
    const models = runModelsOf({
      ...incident,
      run: {
        ...incident.run!,
        fanout: { leadProvider: "meta", leadModel: "muse-wonder-1.0", leadReasoningEffort: "high", hypotheses: [] },
      },
      fixRun: { status: "proven", attempt: 1, startedAt: detectedAt, provider: "meta", model: "muse-spark-1.3", reasoningEffort: "medium" },
      postmortem: undefined,
    });
    assert.deepEqual(models, {
      investigate: { provider: "meta", model: "muse-spark-1.3", effort: "high" },
      lead: { provider: "meta", model: "muse-wonder-1.0", effort: "high" },
      fix: { provider: "meta", model: "muse-spark-1.3", effort: "medium" },
    });
  });

  it("prefers the models a re-run was started with", () => {
    const rerun = rerunOf(scenarioIncident());
    assert.deepEqual(runModelsOf(rerun), rerun.models);
  });
});

describe("recovered", () => {
  it("cuts off a re-run still running when Triage restarts", () => {
    const base = scenarioIncident();
    const incident: Incident = { ...base, reruns: [rerunOf(base, { status: "investigating", report: undefined })] };
    const next = recovered(incident, "2026-11-02T11:00:00.000Z")!;
    const rerun = next.reruns![0];
    assert.equal(rerun.status, "failed");
    assert.match(rerun.run!.error!, /restarted/);
    assert.equal(next.status, "diagnosed");
  });
});
