import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { changedRange, parsePatch, splitRows } from "./diff";

// The shape of the fix the sandbox produced for the stock leak: a file
// without "diff --git" headers, then a new file.
const patch = `--- a/src/lib/stock.ts
+++ b/src/lib/stock.ts
@@ -39,5 +39,8 @@ async function getStockLevelOrm(productId: number): Promise<number> {
 async function getStockLevelDirect(productId: number): Promise<number> {
   const client = await pool.connect();
-  const { rows } = await client.query("SELECT 1");
-  client.release();
+  try {
+    const { rows } = await client.query("SELECT 1");
+  } finally {
+    client.release();
+  }
   return rows[0];
--- /dev/null
+++ b/src/lib/stock.test.ts
@@ -0,0 +1,2 @@
+import { describe } from "vitest";
+-- a line that looks like a header
`;

describe("parsePatch", () => {
  const files = parsePatch(patch);

  it("splits files, with their status and counts", () => {
    assert.deepEqual(
      files.map((f) => [f.path, f.status, f.additions, f.deletions]),
      [
        ["src/lib/stock.ts", "modified", 5, 2],
        ["src/lib/stock.test.ts", "added", 2, 0],
      ],
    );
  });

  it("numbers each line on its side", () => {
    const [hunk] = files[0].hunks;
    assert.equal(hunk.section, "async function getStockLevelOrm(productId: number): Promise<number> {");
    assert.deepEqual(hunk.lines[0], {
      kind: "context",
      text: "async function getStockLevelDirect(productId: number): Promise<number> {",
      oldNo: 39,
      newNo: 39,
    });
    assert.deepEqual([hunk.lines[2].kind, hunk.lines[2].oldNo, hunk.lines[2].newNo], ["del", 41, undefined]);
    assert.deepEqual([hunk.lines[4].kind, hunk.lines[4].oldNo, hunk.lines[4].newNo], ["add", undefined, 41]);
    // The last context line: two removed and five added lines before it.
    assert.deepEqual([hunk.lines.at(-1)!.oldNo, hunk.lines.at(-1)!.newNo], [43, 46]);
  });

  it("keeps an added line that looks like a file header inside its hunk", () => {
    assert.equal(files[1].hunks[0].lines[1].text, "-- a line that looks like a header");
  });

  it("reads git's headers and skips the no-newline marker", () => {
    const git = parsePatch(
      'diff --git a/a.ts b/a.ts\nindex 1..2 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n\\ No newline at end of file\n+y\n',
    );
    assert.deepEqual(
      git[0].hunks[0].lines.map((l) => [l.kind, l.text]),
      [
        ["del", "x"],
        ["add", "y"],
      ],
    );
  });
});

describe("splitRows", () => {
  it("lines up re-indented lines with what they were, new lines against blanks", () => {
    const rows = splitRows(parsePatch(patch)[0].hunks[0].lines);
    assert.deepEqual(
      rows.map((r) => [r.left?.text.trim(), r.right?.text.trim()]),
      [
        ["async function getStockLevelDirect(productId: number): Promise<number> {", "async function getStockLevelDirect(productId: number): Promise<number> {"],
        ["const client = await pool.connect();", "const client = await pool.connect();"],
        [undefined, "try {"],
        ['const { rows } = await client.query("SELECT 1");', 'const { rows } = await client.query("SELECT 1");'],
        [undefined, "} finally {"],
        ["client.release();", "client.release();"],
        [undefined, "}"],
        ["return rows[0];", "return rows[0];"],
      ],
    );
  });

  it("pairs unrelated replacements in order", () => {
    const rows = splitRows(parsePatch("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-alpha()\n-beta()\n+gamma(1, 2, 3)\n+delta\n")[0].hunks[0].lines);
    assert.deepEqual(
      rows.map((r) => [r.left?.text, r.right?.text]),
      [
        ["alpha()", "gamma(1, 2, 3)"],
        ["beta()", "delta"],
      ],
    );
  });
});

describe("changedRange", () => {
  it("marks what changed between two similar lines", () => {
    // "500" -> "1000" share their trailing "00", so just "5" -> "10".
    assert.deepEqual(changedRange("const limit = 500;", "const limit = 1000;"), { del: [14, 15], add: [14, 16] });
  });

  it("marks a re-indent as the added indent", () => {
    assert.deepEqual(changedRange("  client.release();", "    client.release();"), { del: [2, 2], add: [2, 4] });
  });

  it("leaves unrelated lines unmarked", () => {
    assert.equal(changedRange("return rows[0];", "} finally {"), undefined);
  });
});
