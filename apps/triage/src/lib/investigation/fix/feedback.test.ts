import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { feedbackBlock, repeatsDenied } from "./feedback";

// A fix and its test, as the sandbox's diff writes them (no "diff --git"
// header, the test as a new file after the code).
const code = `--- a/src/db/client.ts
+++ b/src/db/client.ts
@@ -10,3 +10,5 @@ export async function query(sql: string) {
   const client = await pool.connect();
-  return client.query(sql);
+  try {
+    return await client.query(sql);
+  } finally {
+    client.release();
+  }
 }`;
const test = (name: string) => `--- /dev/null
+++ b/src/db/${name}.test.ts
@@ -0,0 +1,4 @@
+import { it, expect } from "vitest";
+it("releases the connection", async () => {
+  expect(1).toBe(1);
+});`;
const denied = `${code}\n${test("client")}`;
const otherCode = code.replace("client.release();", "client.release(true);");

describe("feedbackBlock", () => {
  it("is empty with nothing denied", () => {
    assert.equal(feedbackBlock([]), "");
  });

  it("quotes the feedback and the patch, and says a repeat is rejected", () => {
    const block = feedbackBlock([{ reason: "don't change the query, only release the connection", patch: denied }]);
    assert.ok(block.startsWith("A reviewer denied the previous fix with this feedback: 'don't change the query, only release the connection'."));
    assert.ok(block.includes(`Its patch:\n${denied}`));
    assert.ok(block.endsWith("Follow the feedback. A patch identical to a denied one is rejected."));
  });

  it("lists every denied attempt, oldest first, the last as the previous fix", () => {
    const block = feedbackBlock([
      { reason: "first", patch: denied },
      { reason: "second", patch: otherCode },
    ]);
    const first = block.indexOf("A reviewer denied an earlier fix (attempt 1) with this feedback: 'first'.");
    const second = block.indexOf("A reviewer denied the previous fix with this feedback: 'second'.");
    assert.ok(first !== -1 && second !== -1 && first < second);
  });
});

describe("repeatsDenied", () => {
  const feedback = [
    { reason: "first", patch: denied },
    { reason: "second", patch: `${otherCode}\n${test("client")}` },
  ];

  it("names the attempt a byte-equal patch repeats", () => {
    assert.equal(repeatsDenied(denied, feedback), 1);
    assert.equal(repeatsDenied(`${otherCode}\n${test("client")}`, feedback), 2);
  });

  it("counts the same code change with a different test as a repeat", () => {
    assert.equal(repeatsDenied(`${code}\n${test("pool")}`, feedback), 1);
  });

  it("lets a different code change through", () => {
    const changed = code.replace("client.release();", "pool.release(client);");
    assert.equal(repeatsDenied(`${changed}\n${test("client")}`, feedback), 0);
    assert.equal(repeatsDenied(changed, []), 0);
  });
});
