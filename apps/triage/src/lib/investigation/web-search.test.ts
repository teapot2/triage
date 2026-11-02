import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Citation } from "ai";
import { assignId, type EvidenceDraft } from "./recorder";
import type { Evidence, EvidenceKind, ToolName } from "./schema";
import {
  answerOf,
  beforeAnswer,
  citedPages,
  countSearches,
  recordPages,
  searchSummary,
  usedPages,
  withWebCitations,
} from "./web-search";

const POOL = "https://github.com/brianc/node-postgres/blob/HEAD/docs/pages/apis/pool.mdx";

const cite = (url: string, endIndex: number, title?: string): Citation => ({
  source: { type: "source", sourceType: "url", id: url, url, title },
  startIndex: 0,
  endIndex,
});

// Records like QuestionRecorder does, without saving.
function recorder() {
  const counters = new Map<EvidenceKind, number>();
  const evidence: Evidence[] = [];
  return {
    evidence,
    recordEvidence(tool: ToolName, drafts: EvidenceDraft[]) {
      const added = drafts.map((d) => assignId(counters, "ev_q1_", d, tool));
      evidence.push(...added);
      return added;
    },
  };
}

describe("withWebCitations", () => {
  it("puts the ID where the cited words end, before the full stop", () => {
    const text = "connectionTimeoutMillis defaults to 0, meaning no timeout.";
    const ids = new Map([[POOL, "ev_q1_web_1"]]);
    assert.equal(
      withWebCitations(text, [cite(POOL, text.length)], ids),
      "connectionTimeoutMillis defaults to 0, meaning no timeout [ev_q1_web_1].",
    );
  });

  it("joins pages cited at the same place and keeps earlier ones in place", () => {
    const text = "First claim. Second claim.";
    const other = "https://node-postgres.com/apis/pool";
    const ids = new Map([
      [POOL, "ev_web_1"],
      [other, "ev_web_2"],
    ]);
    assert.equal(
      withWebCitations(text, [cite(POOL, 12), cite(POOL, text.length), cite(other, text.length)], ids),
      "First claim [ev_web_1]. Second claim [ev_web_1, ev_web_2].",
    );
  });

  it("leaves a page with no ID out", () => {
    assert.equal(withWebCitations("Claim.", [cite(POOL, 6)], new Map()), "Claim.");
  });
});

describe("answerOf and beforeAnswer", () => {
  const content = [
    { type: "text", text: "I'll look up the docs." },
    { type: "tool-call", toolName: "web_search" },
    { type: "tool-result", toolName: "web_search", output: { action: { type: "search", query: "pg pool" } } },
    { type: "text", text: "Per the docs, ", citations: [] },
    { type: "text", text: "it waits forever.", citations: [cite(POOL, 17)] },
  ];

  it("takes the text after the last search, citations counted from its start", () => {
    const answer = answerOf(content);
    assert.equal(answer.text, "Per the docs, it waits forever.");
    assert.equal(answer.citations[0].endIndex, "Per the docs, it waits forever.".length);
  });

  it("leaves the thinking aloud before it", () => {
    assert.deepEqual(
      beforeAnswer(content).filter((p) => p.type === "text").map((p) => p.text),
      ["I'll look up the docs."],
    );
  });

  it("treats a call without a search as all answer, and all thought", () => {
    const plain = [{ type: "text", text: "No search here." }];
    assert.equal(answerOf(plain).text, "No search here.");
    assert.equal(beforeAnswer(plain).length, 1);
  });

  it("counts the searches", () => {
    assert.equal(countSearches([{ content }, { content }]), 2);
  });
});

describe("recordPages", () => {
  it("records each http page once, titled when it has one", () => {
    const r = recorder();
    const ids = recordPages(r, [
      { url: POOL },
      ...citedPages([cite(POOL, 1, "pool.mdx"), cite("javascript:alert(1)", 3), cite("https://node-postgres.com/", 9)]),
    ]);
    assert.deepEqual([...ids], [
      [POOL, "ev_q1_web_1"],
      ["https://node-postgres.com/", "ev_q1_web_2"],
    ]);
    assert.equal(r.evidence[0].summary, "pool.mdx");
    assert.equal(r.evidence[1].summary, "node-postgres.com");
  });

  it("records nothing without citations", () => {
    const r = recorder();
    assert.equal(recordPages(r, []).size, 0);
    assert.equal(r.evidence.length, 0);
  });
});

describe("usedPages", () => {
  it("takes the pages cited in text and the pages opened, not the ones only found", () => {
    const steps = [
      {
        content: [
          { type: "tool-result", toolName: "web_search", output: { action: { type: "search", query: "pg" } } },
          { type: "tool-result", toolName: "web_search", output: { action: { type: "openPage", url: POOL } } },
          { type: "text", text: "Docs say so.", citations: [cite("https://node-postgres.com/", 12, "Pool")] },
        ],
      },
    ];
    assert.deepEqual(usedPages(steps), [{ url: POOL }, { url: "https://node-postgres.com/", title: "Pool" }]);
  });
});

describe("searchSummary", () => {
  it("says what the search did", () => {
    assert.equal(searchSummary({ action: { type: "search", query: "pg pool timeout" } }), 'Searched "pg pool timeout"');
    assert.equal(searchSummary({ action: { type: "openPage", url: POOL } }), `Opened github.com${new URL(POOL).pathname}`);
    assert.equal(searchSummary(undefined), "Searched the web");
  });
});
