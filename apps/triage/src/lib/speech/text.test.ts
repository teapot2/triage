import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { speakableText } from "./text";

describe("speakableText", () => {
  it("drops citations and the space before them", () => {
    assert.equal(
      speakableText("Pool waits rose [ev_span_1] while the cache stayed fast [ev_q2_metric_1]."),
      "Pool waits rose while the cache stayed fast.",
    );
  });

  it("drops a bracket with several IDs, and one with backticks inside", () => {
    assert.equal(speakableText("Both agree [ev_log_3, ev_span_1; `ev_db_2`]."), "Both agree.");
  });

  it("keeps brackets that cite nothing", () => {
    assert.equal(speakableText("The array [1, 2] is sorted."), "The array [1, 2] is sorted.");
  });

  it("returns an empty string for empty or blank input", () => {
    assert.equal(speakableText(""), "");
    assert.equal(speakableText("  \n\n \t "), "");
  });

  it("returns an empty string for text that is only citations", () => {
    assert.equal(speakableText("[ev_log_3] [ev_span_1, ev_db_2]"), "");
    assert.equal(speakableText("- [ev_log_3]\n- [ev_span_1]"), "");
  });

  it("unwraps inline code", () => {
    assert.equal(speakableText("Set `max_connections` to `50`."), "Set max_connections to 50.");
  });

  it("unwraps bold and italic marks", () => {
    assert.equal(speakableText("The **root cause** is *the pool* and __the retries__."), "The root cause is the pool and the retries.");
  });

  it("leaves a lone asterisk and snake_case alone", () => {
    assert.equal(speakableText("2 * 3 and my_var_name stay."), "2 * 3 and my_var_name stay.");
  });

  it("turns dash, star and dot bullets into sentences", () => {
    assert.equal(speakableText("Causes:\n- the pool\n* the retries\n• the cache"), "Causes: the pool. the retries. the cache.");
  });

  it("keeps an item's own end punctuation", () => {
    assert.equal(speakableText("- Is it the pool?\n- Yes!\n- Note: see below;\n- Done."), "Is it the pool? Yes! Note: see below; Done.");
  });

  it("turns numbered lists with a dot or a parenthesis into sentences", () => {
    assert.equal(speakableText("1. Roll back\n2) Raise the limit\n10. Watch the graph"), "Roll back. Raise the limit. Watch the graph.");
  });

  it("does not treat bold at the start of a line as a bullet", () => {
    assert.equal(speakableText("**Fix** the pool"), "Fix the pool");
  });

  it("drops heading marks and ends the heading", () => {
    assert.equal(speakableText("## Root cause\nThe pool ran dry."), "Root cause. The pool ran dry.");
  });

  it("keeps link text and drops the URL", () => {
    assert.equal(
      speakableText("See [the runbook](https://example.com/runbook?a=1) and ![chart](https://example.com/c.png)."),
      "See the runbook and chart.",
    );
  });

  it("joins the lines of a paragraph with a space", () => {
    assert.equal(speakableText("The pool\nran dry\nat noon."), "The pool ran dry at noon.");
  });

  it("makes a paragraph break a sentence break", () => {
    assert.equal(speakableText("The pool ran dry\n\nRetries piled up."), "The pool ran dry. Retries piled up.");
  });

  it("keeps a paragraph's own end punctuation at a break", () => {
    assert.equal(speakableText("Did it fail?\n\nYes."), "Did it fail? Yes.");
  });

  it("does not add a period to the end of the text", () => {
    assert.equal(speakableText("The pool ran dry"), "The pool ran dry");
  });

  it("ends a paragraph that leads into a list", () => {
    assert.equal(speakableText("Two causes\n- the pool\n- the retries"), "Two causes. the pool. the retries.");
  });

  it("reads the lines of a fenced block without the fences", () => {
    assert.equal(speakableText("Run:\n```sh\npnpm test\n```\nThen wait."), "Run: pnpm test. Then wait.");
  });

  it("collapses runs of whitespace and CRLF line breaks", () => {
    assert.equal(speakableText("  The   pool\t ran\r\ndry.  \r\n\r\n\r\n  Retries   piled up. "), "The pool ran dry. Retries piled up.");
  });

  it("reads a whole answer", () => {
    const answer = [
      "## What happened",
      "The **checkout** pool ran out of `connections` [ev_span_1].",
      "",
      "Next steps:",
      "- Raise `max_connections` [ev_log_3, ev_log_4]",
      "- Read [the runbook](https://example.com/rb)",
      "",
      "1. Roll back",
    ].join("\n");
    assert.equal(
      speakableText(answer),
      "What happened. The checkout pool ran out of connections. Next steps: Raise max_connections. Read the runbook. Roll back.",
    );
  });
});
