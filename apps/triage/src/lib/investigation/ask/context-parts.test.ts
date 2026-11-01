import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tool } from "ai";
import { z } from "zod";
import { type PromptText, splitTokens, toolsText } from "./context-parts";

const text = (lengths: number[]): PromptText => {
  const [instructions, tools, report, evidence, history, question] = lengths.map((n) => "x".repeat(n));
  return { instructions, tools, report, evidence, history, question };
};

describe("splitTokens", () => {
  it("shares the input between the parts by length", () => {
    const parts = splitTokens(1000, text([100, 0, 300, 500, 0, 100]), false);
    assert.deepEqual(parts, { instructions: 100, tools: 0, report: 300, evidence: 500, history: 0, question: 100 });
  });

  it("gives a screenshot what the text doesn't account for", () => {
    const parts = splitTokens(3000, text([400, 0, 400, 0, 0, 0]), true);
    assert.equal(parts.instructions + parts.report, 200);
    assert.equal(parts.screenshot, 2800);
  });

  it("never gives a screenshot less than nothing", () => {
    const parts = splitTokens(100, text([4000, 0, 0, 0, 0, 0]), true);
    assert.equal(parts.instructions, 100);
    assert.equal(parts.screenshot, 0);
  });
});

describe("toolsText", () => {
  it("is empty without tools and names each tool with its schema", async () => {
    assert.equal(await toolsText({}), "");
    const t = await toolsText({
      read_source: tool({ description: "Read a file", inputSchema: z.object({ path: z.string() }) }),
    });
    assert.match(t, /"name":"read_source"/);
    assert.match(t, /"path"/);
  });
});
