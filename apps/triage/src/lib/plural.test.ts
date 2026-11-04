import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { plural } from "./plural";

describe("plural", () => {
  it("uses the singular for one and adds an s otherwise", () => {
    assert.equal(plural(1, "log group"), "1 log group");
    assert.equal(plural(0, "span"), "0 spans");
    assert.equal(plural(3, "commit"), "3 commits");
  });

  it("takes an irregular plural", () => {
    assert.equal(plural(2, "query", "queries"), "2 queries");
    assert.equal(plural(1, "query", "queries"), "1 query");
  });
});
