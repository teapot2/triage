import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  builtInSections,
  customSections,
  defaultTemplate,
  isDefaultTemplate,
  keptBuiltIns,
  sectionId,
  type Template,
  templateProblems,
  templateSchema,
} from "./template";

const custom = (id: string, name = "Customer communication") => ({
  kind: "custom" as const,
  id,
  name,
  instructions: "Who was told what and when, from the record",
});

describe("defaultTemplate", () => {
  it("is the seven built-in sections in order, and valid", () => {
    assert.deepEqual(keptBuiltIns(defaultTemplate), [...builtInSections]);
    assert.equal(templateSchema.safeParse(defaultTemplate).success, true);
    assert.deepEqual(templateProblems(defaultTemplate), []);
    assert.equal(isDefaultTemplate(defaultTemplate), true);
  });
});

describe("sectionId", () => {
  it("lowercases and joins runs of other characters with one dash", () => {
    assert.equal(sectionId("Customer communication", new Set()), "customer-communication");
    assert.equal(sectionId("  Who -- was told? (and when)  ", new Set()), "who-was-told-and-when");
  });

  it("adds -2, -3… while the id is taken", () => {
    const taken = new Set(["customer-communication", "customer-communication-2"]);
    assert.equal(sectionId("Customer Communication", taken), "customer-communication-3");
  });

  it("is never empty", () => {
    assert.equal(sectionId("???", new Set()), "section");
    assert.equal(sectionId("", new Set()), "section");
    assert.equal(sectionId("???", new Set(["section"])), "section-2");
  });

  it("makes ids the schema accepts", () => {
    const id = sectionId("Ünïcode & spaces", new Set());
    assert.match(id, /^[a-z0-9-]+$/);
  });
});

describe("templateProblems", () => {
  it("accepts reordered and reduced templates", () => {
    const t: Template = {
      sections: [
        { kind: "builtin", key: "actions" },
        custom("customer-communication"),
        { kind: "builtin", key: "summary" },
      ],
    };
    assert.deepEqual(templateProblems(t), []);
  });

  it("flags a built-in section twice", () => {
    const t: Template = {
      sections: [
        { kind: "builtin", key: "summary" },
        { kind: "builtin", key: "summary" },
      ],
    };
    const problems = templateProblems(t);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /summary/);
  });

  it("flags a custom id twice", () => {
    const problems = templateProblems({ sections: [custom("comms"), custom("comms", "Comms again")] });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /comms/);
  });

  it("flags an empty list", () => {
    assert.equal(templateProblems({ sections: [] }).length, 1);
  });
});

describe("template schema", () => {
  it("rejects bad ids, empty names and instructions, and empty or oversized lists", () => {
    const bad = (section: unknown) => templateSchema.safeParse({ sections: [section] }).success;
    assert.equal(bad({ kind: "custom", id: "Not Valid", name: "x", instructions: "y" }), false);
    assert.equal(bad({ kind: "custom", id: "ok", name: "", instructions: "y" }), false);
    assert.equal(bad({ kind: "custom", id: "ok", name: "x", instructions: "" }), false);
    assert.equal(bad({ kind: "custom", id: "ok", name: "x".repeat(61), instructions: "y" }), false);
    assert.equal(bad({ kind: "custom", id: "ok", name: "x", instructions: "y".repeat(501) }), false);
    assert.equal(bad({ kind: "builtin", key: "nope" }), false);
    assert.equal(templateSchema.safeParse({ sections: [] }).success, false);
    const many = Array.from({ length: 21 }, (_, i) => custom(`s-${i}`));
    assert.equal(templateSchema.safeParse({ sections: many }).success, false);
  });
});

describe("helpers", () => {
  const t: Template = {
    sections: [
      { kind: "builtin", key: "impact" },
      custom("comms"),
      { kind: "builtin", key: "summary" },
    ],
  };

  it("customSections and keptBuiltIns split the template, in order", () => {
    assert.deepEqual(keptBuiltIns(t), ["impact", "summary"]);
    assert.deepEqual(
      customSections(t).map((s) => s.id),
      ["comms"],
    );
  });

  it("isDefaultTemplate is false for any reordering, removal or addition", () => {
    assert.equal(isDefaultTemplate(t), false);
    assert.equal(isDefaultTemplate({ sections: [...defaultTemplate.sections].reverse() }), false);
    assert.equal(isDefaultTemplate({ sections: defaultTemplate.sections.slice(1) }), false);
    assert.equal(isDefaultTemplate({ sections: [...defaultTemplate.sections, custom("x")] }), false);
  });
});
