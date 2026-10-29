import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { archiveDeniedFix, canRerunFix } from "./approval";
import { exampleIncidents } from "./fixtures";
import type { Approval, FixRun, Incident } from "./schema";

const proven: FixRun = { status: "proven", attempt: 2, startedAt: "2026-10-28T10:01:00.000Z", model: "muse-spark-1.3" };

// The pool-leak example (it has a fix and a pending approval), as if it had
// run against the given source with the given fix stage outcome.
function incident(source: string | undefined, fixRun: FixRun | undefined = proven): Incident {
  const example = structuredClone(exampleIncidents.find((i) => i.fix && i.approval)!);
  return {
    ...example,
    status: "awaiting_approval",
    fixRun,
    run: source === undefined ? undefined : { source, model: "muse-spark-1.3", startedAt: "2026-10-28T10:00:00.000Z" },
  };
}

describe("canRerunFix", () => {
  it("is true only for a proven fix on the live Shopfront", () => {
    assert.equal(canRerunFix(incident("live:shopfront")), true);
    assert.equal(canRerunFix(incident("live:shopfront", { ...proven, status: "failed" })), false);
    assert.equal(canRerunFix({ ...incident("live:shopfront"), fixRun: undefined }), false);
    assert.equal(canRerunFix(incident("scenario:pool-leak")), false);
    assert.equal(canRerunFix(incident(undefined)), false);
  });
});

describe("archiveDeniedFix", () => {
  const denied: Approval = {
    state: "denied",
    requestedAt: "2026-10-28T10:02:00.000Z",
    decidedAt: "2026-10-28T10:05:00.000Z",
    reason: "don't change the query, only release the connection",
  };

  it("moves the fix, its proof and the decision into fixAttempts and starts the fix stage over", () => {
    const before = incident("live:shopfront");
    const after = archiveDeniedFix(before, denied, "2026-10-28T10:05:00.000Z");
    assert.equal(after.status, "diagnosed");
    assert.equal(after.fix, undefined);
    assert.equal(after.validation, undefined);
    assert.equal(after.approval, undefined);
    assert.deepEqual(after.fixRun, { status: "writing", attempt: 0, startedAt: "2026-10-28T10:05:00.000Z" });
    assert.deepEqual(after.fixAttempts, [
      { fix: before.fix, validation: before.validation, fixRun: proven, approval: denied },
    ]);
    // Everything else is as it was.
    assert.deepEqual(after.report, before.report);
    assert.deepEqual(after.evidence, before.evidence);
    assert.deepEqual(after.steps, before.steps);
  });

  it("keeps earlier denied attempts, oldest first", () => {
    const first = archiveDeniedFix(incident("live:shopfront"), denied);
    const second = archiveDeniedFix(
      { ...first, fix: { ...first.fixAttempts![0].fix, summary: "Second try." }, fixRun: proven, approval: { ...denied, state: "pending" } },
      { ...denied, reason: "keep the retry loop" },
    );
    assert.equal(second.fixAttempts?.length, 2);
    assert.equal(second.fixAttempts?.[0].approval.reason, denied.reason);
    assert.equal(second.fixAttempts?.[1].fix.summary, "Second try.");
    assert.equal(second.fixAttempts?.[1].approval.reason, "keep the retry loop");
  });

  it("leaves the incident it was given alone", () => {
    const before = incident("live:shopfront");
    const copy = structuredClone(before);
    archiveDeniedFix(before, denied);
    assert.deepEqual(before, copy);
  });
});
