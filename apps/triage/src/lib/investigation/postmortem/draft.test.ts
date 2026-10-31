import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePartialJson } from "ai";
import type { DraftContent } from "../schema";
import { draftContent, draftLength, nextAttempt, progressOf, revealDraft, sectionStates, writingSection } from "./draft";
import { defaultTemplate, type Template } from "./template";

const known = new Set(["ev_log_1", "ev_log_12", "ev_metric_1"]);

const comms = { kind: "custom" as const, id: "comms", name: "Customer communication", instructions: "Who was told" };
const team: Template = { sections: [{ kind: "builtin", key: "summary" }, comms, { kind: "builtin", key: "actions" }] };

// The submission cut off after `n` characters, as the writer parses it.
async function cut(json: string, n: number) {
  return (await parsePartialJson(json.slice(0, n))).value;
}

const full = JSON.stringify({
  summary: "The pool ran out.",
  impact: { text: "Checkout failed.", evidenceIds: ["ev_log_12"] },
  contributingFactors: [{ text: "No pool alert.", evidenceIds: ["ev_metric_1"] }],
});

describe("draftContent", () => {
  it("keeps what has arrived, cut where the JSON is", async () => {
    const value = await cut(full, full.indexOf("Checkout") + 5);
    assert.deepEqual(draftContent(value, known, defaultTemplate), {
      summary: "The pool ran out.",
      impact: { text: "Check", evidenceIds: [] },
    });
  });

  it("cites only evidence IDs it knows, so a cut-off ID waits", async () => {
    const at = full.indexOf("ev_log_12") + "ev_log_1".length;
    const value = await cut(full, at);
    // "ev_log_1" is known too, so this one shows; "ev_log_" would not.
    assert.deepEqual(draftContent(value, known, defaultTemplate).impact?.evidenceIds, ["ev_log_1"]);
    const shorter = await cut(full, at - 1);
    assert.deepEqual(draftContent(shorter, known, defaultTemplate).impact?.evidenceIds, []);
  });

  it("keeps an action item before its kind and priority arrive, and drops cut-off ones", () => {
    const content = draftContent({ actionItems: [{ title: "Alert on the pool", kind: "detect_soo" }] }, known, defaultTemplate);
    assert.deepEqual(content.actionItems, [{ title: "Alert on the pool", kind: undefined, priority: undefined, evidenceIds: [] }]);
  });

  it("takes custom sections once their id is the template's", () => {
    const partial = { custom: [{ id: "comms", text: "No one" }, { id: "com" }] };
    assert.deepEqual(draftContent(partial, known, team).custom, [{ id: "comms", text: "No one", evidenceIds: [] }]);
  });

  it("is empty for anything but an object", () => {
    assert.deepEqual(draftContent(undefined, known, defaultTemplate), {});
    assert.deepEqual(draftContent("x", known, defaultTemplate), {});
  });
});

describe("writingSection", () => {
  it("is the section of the last field, in the order the JSON came", async () => {
    assert.equal(writingSection(await cut(full, 15)), "summary");
    assert.equal(writingSection(await cut(full, full.indexOf("No pool"))), "factors");
    assert.equal(writingSection({ summary: "", wentBadly: [] }), "lessons");
    assert.equal(writingSection({ custom: [{ id: "comms" }] }), "custom:comms");
    assert.equal(writingSection({}), undefined);
  });
});

describe("sectionStates", () => {
  it("has the sections above the cursor done and the rest pending", () => {
    assert.deepEqual(Object.fromEntries(sectionStates(defaultTemplate, "impact")), {
      summary: "done",
      impact: "writing",
      timeline: "pending",
      factors: "pending",
      lessons: "pending",
      lucky: "pending",
      actions: "pending",
    });
  });

  it("is all done without a cursor", () => {
    assert.ok([...sectionStates(team, undefined).values()].every((s) => s === "done"));
  });
});

describe("progressOf", () => {
  it("is complete once something was written and no field is open", () => {
    assert.deepEqual(progressOf({ attempt: 1, content: {} }), { open: undefined, complete: false });
    assert.deepEqual(progressOf({ attempt: 1, writing: "lessons", content: { summary: "s" } }), { open: "lessons", complete: false });
    assert.deepEqual(progressOf({ attempt: 1, content: { summary: "s" } }), { open: undefined, complete: true });
  });
});

describe("revealDraft while the submission streams", () => {
  // Meta's model sorts the fields: the action items come first.
  const sorted: DraftContent = { actionItems: [{ title: "Alert on the pool", kind: "detect_sooner", priority: "P2" }], contributingFactors: [] };

  it("waits at the first section not started, whatever came below it", () => {
    const { content: shown, at, used } = revealDraft(sorted, defaultTemplate, Infinity, { open: "factors", complete: false });
    assert.equal(at, "summary");
    assert.deepEqual(shown, {});
    assert.equal(used, 0);
  });

  it("stops at the open section, as far as it has come", () => {
    const content: DraftContent = { ...sorted, summary: "Pool ran out.", impact: { text: "Checkout fail", evidenceIds: [] } };
    const { content: shown, at } = revealDraft(content, defaultTemplate, Infinity, { open: "impact", complete: false });
    assert.equal(at, "impact");
    assert.deepEqual(shown, { summary: "Pool ran out.", impact: { text: "Checkout fail", evidenceIds: [] } });
  });

  it("reads past a closed section and the timeline to the next one", () => {
    const content: DraftContent = { ...sorted, summary: "S.", impact: { text: "I.", evidenceIds: [] } };
    const { at } = revealDraft(content, defaultTemplate, Infinity, { open: "factors", complete: false });
    assert.equal(at, "factors");
  });

  it("skips what a complete submission left out", () => {
    const { content: shown, at } = revealDraft(sorted, defaultTemplate, Infinity, { open: undefined, complete: true });
    assert.equal(at, undefined);
    assert.deepEqual(shown, sorted);
  });
});


describe("revealDraft", () => {
  const content: DraftContent = {
    summary: "Pool ran out.",
    impact: { text: "Checkout failed.", evidenceIds: ["ev_log_12"] },
    lucky: ["Low traffic."],
  };

  it("walks the sections in the template's order, cutting at the budget", () => {
    const { content: shown, at } = revealDraft(content, defaultTemplate, 13 + 8);
    assert.equal(at, "impact");
    assert.deepEqual(shown, { summary: "Pool ran out.", impact: { text: "Checkout", evidenceIds: [] } });
  });

  it("shows a claim's citations once its text is whole", () => {
    const { content: shown, at } = revealDraft(content, defaultTemplate, 13 + 16);
    assert.deepEqual(shown.impact, { text: "Checkout failed.", evidenceIds: ["ev_log_12"] });
    assert.equal(at, "lucky");
    assert.deepEqual(shown.lucky, [""]);
  });

  it("is the whole draft once the budget covers it", () => {
    const { content: shown, at, used } = revealDraft(content, defaultTemplate, Infinity);
    assert.deepEqual(shown, content);
    assert.equal(at, undefined);
    assert.equal(used, draftLength(content, defaultTemplate));
    assert.equal(used, 13 + 16 + 12);
  });

  it("follows a custom section where the template puts it", () => {
    const withCustom: DraftContent = { summary: "S.", actionItems: [{ title: "Do it", kind: "fix_this" }], custom: [{ id: "comms", text: "None.", evidenceIds: [] }] };
    const { content: shown, at } = revealDraft(withCustom, team, 2 + 3);
    assert.equal(at, "custom:comms");
    assert.deepEqual(shown, { summary: "S.", custom: [{ id: "comms", text: "Non", evidenceIds: [] }] });
  });
});

describe("nextAttempt", () => {
  it("counts attempts and keeps why the last was rejected", () => {
    const first = nextAttempt(undefined);
    assert.deepEqual(first, { attempt: 1, content: {} });
    assert.deepEqual(nextAttempt({ ...first, content: { summary: "x" } }, ["too few factors"]), {
      attempt: 2,
      content: {},
      problems: ["too few factors"],
    });
  });
});
