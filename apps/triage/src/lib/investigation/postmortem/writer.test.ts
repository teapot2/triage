import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { instructionsFor, submissionSchemaFor, submitDescription } from "./writer";
import { defaultTemplate, type Template } from "./template";

const comms = {
  kind: "custom" as const,
  id: "customer-communication",
  name: "Customer communication",
  instructions: "Who was told what and when, from the record; say if nothing was recorded",
};

// Lucky dropped, Action items before Lessons, one custom section.
const team: Template = {
  sections: [
    { kind: "builtin", key: "summary" },
    { kind: "builtin", key: "actions" },
    { kind: "builtin", key: "lessons" },
    comms,
  ],
};

const fields = (template: Template) => Object.keys((submissionSchemaFor(template) as unknown as { shape: object }).shape).sort();

describe("submissionSchemaFor", () => {
  it("asks for the seven built-in fields and no custom ones by default", () => {
    assert.deepEqual(fields(defaultTemplate), [
      "actionItems",
      "contributingFactors",
      "impact",
      "lucky",
      "summary",
      "wentBadly",
      "wentWell",
    ]);
  });

  it("asks only for the kept sections, and for custom when the template has any", () => {
    assert.deepEqual(fields(team), ["actionItems", "custom", "summary", "wentBadly", "wentWell"]);
  });

  it("takes only the template's custom ids, each with text and evidence IDs", () => {
    const schema = submissionSchemaFor(team);
    const base = {
      summary: "s",
      actionItems: [],
      wentWell: [],
      wentBadly: [],
    };
    const ok = schema.safeParse({ ...base, custom: [{ id: "customer-communication", text: "t", evidenceIds: ["ev_log_1"] }] });
    assert.equal(ok.success, true);
    assert.equal(schema.safeParse({ ...base, custom: [{ id: "other", text: "t", evidenceIds: [] }] }).success, false);
    assert.equal(schema.safeParse(base).success, false, "custom is required when the template has custom sections");
    assert.equal(schema.safeParse({ ...base, summary: undefined, custom: [] }).success, false, "kept fields are required");
  });
});

describe("instructionsFor", () => {
  it("lists the rules of every built-in section by default, and no custom sections", () => {
    const text = instructionsFor(defaultTemplate);
    for (const field of ["summary:", "impact:", "contributingFactors:", "wentWell and wentBadly", "lucky:", "actionItems:"]) {
      assert.ok(text.includes(`- ${field}`), field);
    }
    assert.ok(!text.includes("Custom sections your team asks for"));
  });

  it("drops the rules of removed sections and lists the custom ones", () => {
    const text = instructionsFor(team);
    assert.ok(!text.includes("- lucky:"));
    assert.ok(!text.includes("- contributingFactors:"));
    assert.ok(!text.includes("- impact:"));
    assert.ok(text.includes("- actionItems:"));
    assert.ok(text.includes("Custom sections your team asks for"));
    assert.ok(text.includes(`- customer-communication (Customer communication): ${comms.instructions}`));
    assert.ok(text.includes("Blameless"), "the general rules stay");
  });
});

describe("submitDescription", () => {
  it("names only the checks that apply", () => {
    assert.match(submitDescription(defaultTemplate), /2 to 5 contributing factors.*no action item repeating the fix/);
    const text = submitDescription(team);
    assert.ok(!text.includes("contributing factors"));
    assert.ok(text.includes("every custom section written once"));
  });
});
