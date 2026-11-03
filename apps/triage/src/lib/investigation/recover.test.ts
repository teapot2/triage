import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exampleIncidents } from "./fixtures";
import { recovered } from "./recover";
import type { Incident, Recovery, Verification } from "./schema";

const now = "2026-10-29T11:00:00.000Z";

const recovery: Recovery = {
  metric: "http.server.duration p95",
  threshold: 500,
  since: "2026-10-29T10:00:00.000Z",
  series: [],
  status: "watching",
};

const verification: Verification = {
  after: "mitigation",
  since: "2026-10-29T10:03:00.000Z",
  windowMinutes: 5,
  metric: "http.server.duration p95",
  threshold: 500,
  series: [{ t: "2026-10-29T10:04:00.000Z", value: 140 }],
  status: "verifying",
  startedAt: "2026-10-29T10:03:30.000Z",
};

// The pool-leak example with its mitigation applied.
function incident(r: Recovery, v?: Verification): Incident {
  const example = structuredClone(exampleIncidents.find((i) => i.fix && i.approval)!);
  return {
    ...example,
    mitigation: { ...example.mitigation!, state: "applied", appliedAt: "2026-10-29T10:00:00.000Z", recovery: r },
    verification: v,
  };
}

describe("recovered", () => {
  it("stops a verification still running", () => {
    const next = recovered(incident({ ...recovery, status: "recovered" }, verification), now);
    assert.deepEqual(next?.verification, {
      ...verification,
      status: "stopped",
      finishedAt: now,
      note: "Triage restarted before the verification finished",
    });
    // Nothing resolved it: the status stays.
    assert.equal(next?.status, "awaiting_approval");
    assert.equal(next?.resolvedAt, undefined);
  });

  it("leaves a merged dependency fix's verification running: the audits judge it", () => {
    const deps: Verification = { ...verification, after: "dependencies", windowMinutes: 1, threshold: 1, series: [] };
    const next = recovered(incident({ ...recovery, status: "recovered" }, deps), now);
    assert.equal((next ?? incident({ ...recovery, status: "recovered" }, deps)).verification?.status, "verifying");
  });

  it("gives up a recovery watch still running", () => {
    const next = recovered(incident(recovery), now);
    assert.deepEqual(next?.mitigation?.recovery, {
      ...recovery,
      status: "not_recovered",
      note: "Triage restarted before the recovery watch finished",
    });
  });

  it("cuts both off on a bundled example too", () => {
    const next = recovered(incident(recovery, verification), now, true);
    assert.equal(next?.verification?.status, "stopped");
    assert.equal(next?.mitigation?.recovery?.status, "not_recovered");
  });

  it("fails a postmortem still being written, keeping its draft", () => {
    const draft = { attempt: 1, writing: "summary", content: { summary: "The pool ran" } };
    const writing = { ...incident({ ...recovery, status: "recovered" }), postmortem: { status: "writing" as const, startedAt: now, model: "m", draft } };
    const next = recovered(writing, now, true);
    assert.equal(next?.postmortem?.status, "failed");
    assert.equal(next?.postmortem?.error, "Triage restarted while the postmortem was being written");
    assert.deepEqual(next?.postmortem?.draft, draft);
  });

  it("leaves finished ones alone", () => {
    const done = incident({ ...recovery, status: "recovered" }, { ...verification, status: "resolved", finishedAt: now });
    assert.equal(recovered(done, now), undefined);
  });
});
