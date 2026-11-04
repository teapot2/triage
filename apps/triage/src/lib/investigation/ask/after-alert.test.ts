import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mitigated, poolLeak, reopened, resolved } from "../postmortem/test-incidents";
import { afterAlert } from "./after-alert";

describe("afterAlert", () => {
  it("says nothing happened when no mitigation ran", () => {
    const { text, items } = afterAlert(poolLeak(), "q_1");
    assert.match(text, /After the alert: nothing recorded/);
    assert.equal(items.size, 0);
  });

  it("gives the mitigation, the recovery's minutes and the verification's window, with IDs to cite", () => {
    const incident = resolved();
    incident.mitigation!.output = "FF_X turned off";
    incident.mitigation!.recovery!.series = [
      { t: "2026-10-23T02:16:00.000Z", value: 2400 },
      { t: "2026-10-23T02:17:00.000Z", value: 210 },
    ];
    const { text, items } = afterAlert(incident, "q_2");
    assert.match(text, /applied at 2026-10-23T02:15:20\.000Z\. Output: FF_X turned off/);
    assert.match(text, /Recovery watch \[ev_q2_recovery\], .* per minute from 2026-10-23T02:15:20\.000Z .*: 02:16=2400, 02:17=210\. Recovered at 2026-10-23T02:18:00\.000Z/);
    assert.match(text, /Verification after the mitigation \[ev_q2_verification\], 5 quiet minutes wanted .*: 02:19=180, .* 02:23=180\. Resolved at 2026-10-23T02:23:15\.000Z/);
    assert.match(text, /Resolved at 2026-10-23T02:23:00\.000Z\./);
    assert.match(text, /Status now: resolved\./);
    assert.deepEqual([...items.keys()], ["ev_q2_recovery", "ev_q2_verification"]);
    const verification = items.get("ev_q2_verification")!;
    assert.ok(verification.kind === "metric");
    assert.equal(verification.metric, incident.trigger.metric);
    assert.equal(verification.unit, incident.trigger.unit);
    assert.equal(verification.observed, 180);
    assert.equal(verification.series.length, 5);
  });

  it("leaves a series with no minutes uncited", () => {
    // mitigated()'s recovery has no points.
    const { text, items } = afterAlert(mitigated(), "q_1");
    assert.match(text, /Recovery watch, .*: no minutes read yet\. Recovered/);
    assert.equal(items.size, 0);
  });

  it("gives a breach and each reopening", () => {
    const incident = reopened();
    incident.verification = { ...incident.verification!, status: "breached", breachedAt: "2026-10-23T02:21:00.000Z", breachValue: 900 };
    const { text } = afterAlert(incident, "q_1");
    assert.match(text, /Breached: back past the limit at 2026-10-23T02:21:00\.000Z \(900 ms\)/);
    assert.match(text, /Reopened at 2026-10-23T02:30:00\.000Z by the watch: p95 latency back over 500 ms \(812 ms\)\./);
    assert.doesNotMatch(text, /- Resolved at/);
    assert.match(text, /Status now: awaiting_approval\./);
  });
});
