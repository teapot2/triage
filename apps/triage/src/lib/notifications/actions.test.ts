import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DecideResult } from "../investigation/approval";
import { exampleIncidents } from "../investigation/fixtures";
import type { Incident } from "../investigation/schema";
import { type ActionDeps, type BlockActionsPayload, handleBlockActions } from "./actions";

const incident = structuredClone(exampleIncidents.find((i) => i.fix && i.approval)!);

const click = (actionId: string, user = "U0APPROVER"): BlockActionsPayload => ({
  type: "block_actions",
  user: { id: user, name: "ana" },
  channel: { id: "C0ALERTS" },
  actions: [{ action_id: actionId, value: incident.id }],
});

// Records what each click did.
function fake(decided: DecideResult = { ok: true, incident }) {
  const calls: string[] = [];
  const told: string[] = [];
  const deps: ActionDeps = {
    readBot: async () => ({ botToken: "xoxb-1", appToken: "xapp-1", channel: "C0ALERTS", approvers: ["U0APPROVER"] }),
    tell: async (_bot, _payload, text) => told.push(text),
    decideMitigation: async (id, decision, by) => {
      calls.push(`mitigation ${decision} ${id} by ${by.name} ${by.slackUser}`);
      return decided;
    },
    applyMitigation: async (id) => void calls.push(`apply ${id}`),
    decideFix: async (id, by) => {
      calls.push(`fix approved ${id} by ${by.slackUser}`);
      return decided;
    },
    openPr: async (id) => void calls.push(`open pr ${id}`),
    refresh: async (id) => void calls.push(`refresh ${id}`),
  };
  return { deps, calls, told };
}

describe("handleBlockActions", () => {
  it("approves the mitigation for an approver and runs it", async () => {
    const f = fake();
    await handleBlockActions(click("mitigation_approve"), f.deps);
    assert.deepEqual(f.calls, [`mitigation approved ${incident.id} by ana U0APPROVER`, `apply ${incident.id}`]);
    assert.deepEqual(f.told, []);
  });

  it("denies the mitigation without running anything", async () => {
    const f = fake();
    await handleBlockActions(click("mitigation_deny"), f.deps);
    assert.deepEqual(f.calls, [`mitigation denied ${incident.id} by ana U0APPROVER`]);
  });

  it("approves the fix and opens its PR when the approval says so", async () => {
    const opening: Incident = { ...incident, approval: { ...incident.approval!, state: "approved", prState: "opening" } };
    const f = fake({ ok: true, incident: opening });
    await handleBlockActions(click("fix_approve"), f.deps);
    assert.deepEqual(f.calls, [`fix approved ${incident.id} by U0APPROVER`, `open pr ${incident.id}`]);
  });

  it("refuses someone who isn't an approver, privately, and changes nothing", async () => {
    const f = fake();
    await handleBlockActions(click("mitigation_approve", "U0SOMEONE"), f.deps);
    assert.deepEqual(f.calls, []);
    assert.match(f.told[0], /not on Triage's approver list/);
  });

  it("says why a refused decision changed nothing, and refreshes the card", async () => {
    const f = fake({ ok: false, status: 409, error: "the mitigation is already denied" });
    await handleBlockActions(click("mitigation_approve"), f.deps);
    assert.deepEqual(f.told, ["Nothing changed: the mitigation is already denied."]);
    assert.ok(f.calls.includes(`refresh ${incident.id}`));
    assert.ok(!f.calls.some((c) => c.startsWith("apply")));
  });

  it("answers the test button for anyone, and ignores the link button", async () => {
    const f = fake();
    await handleBlockActions(click("test_button", "U0SOMEONE"), f.deps);
    assert.match(f.told[0], /Buttons work/);
    await handleBlockActions(click("open_triage"), f.deps);
    assert.deepEqual(f.calls, []);
    assert.equal(f.told.length, 1);
  });
});
