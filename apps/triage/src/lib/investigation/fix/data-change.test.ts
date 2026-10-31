import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exampleIncidents } from "../fixtures";
import { fixSchema } from "../schema";
import { dataChangeOf, detectDataChange, patchChanges, patchFor, sqlStatements } from "./data-change";
import { applyEdits } from "./prove";
import { pullRequestText } from "./pull-request";

const example = (id: string) => structuredClone(exampleIncidents.find((i) => i.id === id)!);

const codeFix = {
  file: "src/lib/stock.ts",
  text: `  try {
    const { rows } = await client.query("SELECT on_hand FROM stock_levels WHERE product_id = $1", [productId]);
    return rows[0]?.on_hand ?? DEFAULT_STOCK;
  } finally {
    client.release();
  }`,
};
const migration = {
  file: "drizzle/0004_backfill_product_prices.sql",
  text: `INSERT INTO product_prices (product_id, list_price_cents)
SELECT id, price_cents FROM products;`,
  created: true,
};

describe("detectDataChange", () => {
  it("leaves a code-only fix alone", () => {
    assert.deepEqual(detectDataChange([codeFix], false), { detected: false, reasons: [], files: [], unproven: [] });
  });

  it("flags a new migration, and marks it unproven", () => {
    const change = detectDataChange([migration], false);
    assert.equal(change.detected, true);
    assert.deepEqual(change.files, [migration.file]);
    assert.deepEqual(change.unproven, [migration.file]);
    assert.deepEqual(change.reasons, [`Adds migration ${migration.file} (INSERT)`]);
  });

  it("flags only the migration when a fix has both, so the code still counts as proven", () => {
    const change = detectDataChange([codeFix, migration], false);
    assert.equal(change.detected, true);
    assert.deepEqual(change.files, [migration.file]);
    assert.deepEqual(change.unproven, [migration.file]);
  });

  it("takes the model's word when nothing in the edits shows it", () => {
    const change = detectDataChange([codeFix], true);
    assert.equal(change.detected, true);
    assert.deepEqual(change.files, []);
    assert.deepEqual(change.unproven, []);
    assert.deepEqual(change.reasons, ["The model that wrote the fix says it changes stored data"]);
  });

  it("flags SQL that writes inside application code, without marking the file unproven", () => {
    const change = detectDataChange(
      [{ file: "src/lib/prices.ts", text: 'await db.execute(sql`UPDATE product_prices SET list_price_cents = 0 WHERE false`);' }],
      false,
    );
    assert.equal(change.detected, true);
    assert.deepEqual(change.files, ["src/lib/prices.ts"]);
    assert.deepEqual(change.unproven, []);
    assert.deepEqual(change.reasons, ["Adds SQL that changes data in src/lib/prices.ts (UPDATE)"]);
  });

  it("counts any change to a SQL file, even one with no statement it knows", () => {
    const change = detectDataChange([{ file: "drizzle/0002_tired_stature.sql", text: "-- note" }], false);
    assert.deepEqual(change.reasons, ["Changes migration drizzle/0002_tired_stature.sql"]);
  });
});

describe("sqlStatements", () => {
  it("finds statements at a line start, after ; ( or a quote", () => {
    assert.deepEqual(sqlStatements("DELETE FROM carts WHERE id = 1;"), ["DELETE"]);
    assert.deepEqual(sqlStatements('client.query("INSERT INTO t (a) VALUES (1)")'), ["INSERT"]);
    assert.deepEqual(sqlStatements("sql`\n  ALTER TABLE products ADD COLUMN x int`"), ["ALTER"]);
    assert.deepEqual(sqlStatements("SELECT 1; DROP TABLE carts"), ["DROP"]);
    assert.deepEqual(sqlStatements("CREATE UNIQUE INDEX i ON t (a);\nTRUNCATE carts;"), ["CREATE", "TRUNCATE"]);
    assert.deepEqual(sqlStatements('UPDATE "products" SET price_cents = 1'), ["UPDATE"]);
  });

  it("ignores identifiers, Drizzle's query builder and words in prose", () => {
    const code = `export async function deleteItem(cartId: number) {
  await db.delete(cartItems).where(eq(cartItems.cartId, cartId));
  await db.update(carts).set({ updatedAt: new Date() });
  await db.insert(events).values({ kind: "deleted" });
  const updateCount = createdAt ? 1 : 0;
  toast("Delete from cart?");
  // Update the cache, then insert into the list.
  return { insertInto: 1, dropTable: false };
}`;
    assert.deepEqual(sqlStatements(code), []);
    assert.deepEqual(sqlStatements("const label = 'Created table view';"), []);
    assert.deepEqual(sqlStatements("SELECT on_hand FROM stock_levels WHERE product_id = $1"), []);
  });
});

describe("patchChanges and patchFor", () => {
  const patch = example("inc_price_gap").fix!.patch;

  it("reads each file's added lines and whether it is new", () => {
    const changes = patchChanges(patch);
    assert.deepEqual(
      changes.map((c) => [c.file, c.created]),
      [
        ["src/lib/prices.ts", false],
        ["drizzle/0005_backfill_product_prices.sql", true],
        ["drizzle/meta/_journal.json", false],
        ["src/lib/prices.test.ts", true],
      ],
    );
    assert.match(changes[1].text, /^-- New arrivals/);
    assert.ok(changes[0].text.includes("return row?.amountCents;"));
    assert.ok(!changes[0].text.includes("innerJoin"));
  });

  it("cuts out one file's part of the patch", () => {
    const part = patchFor(patch, ["drizzle/0005_backfill_product_prices.sql"]);
    assert.ok(part.startsWith("--- /dev/null\n+++ b/drizzle/0005_backfill_product_prices.sql\n@@ -0,0 +1,5 @@"));
    assert.ok(!part.includes("prices.ts"));
  });
});

describe("dataChangeOf", () => {
  it("works it out from the patch for a fix saved without it", () => {
    const old = example("inc_pool_leak").fix!;
    assert.equal(old.dataChange, undefined);
    assert.equal(dataChangeOf(old).detected, false);

    const gap = example("inc_price_gap").fix!;
    assert.equal(gap.dataChange, undefined);
    const change = dataChangeOf(gap);
    assert.equal(change.detected, true);
    assert.deepEqual(change.unproven, ["drizzle/0005_backfill_product_prices.sql", "drizzle/meta/_journal.json"]);
    assert.ok(change.reasons.includes("Registers the migration in drizzle/meta/_journal.json (written by Triage)"));
  });

  it("leaves the regression test out: a test may clean up what it creates", () => {
    const fix = example("inc_pool_leak").fix!;
    fix.patch += `\n--- /dev/null\n+++ b/${fix.regressionTest.file}\n@@ -0,0 +1 @@\n+DELETE FROM carts WHERE id = 0;`;
    assert.equal(dataChangeOf(fix).detected, false);
  });

  it("uses the stored value when there is one", () => {
    const fix = { ...example("inc_pool_leak").fix!, dataChange: { detected: true, reasons: ["x"], files: [], unproven: [] } };
    assert.deepEqual(dataChangeOf(fix).reasons, ["x"]);
  });

  it("loads a saved fix that has no dataChange", () => {
    const saved = JSON.parse(JSON.stringify(example("inc_pool_leak").fix)) as Record<string, unknown>;
    assert.equal("dataChange" in saved, false);
    assert.equal(fixSchema.parse(saved).dataChange, undefined);
  });
});

describe("applyEdits", () => {
  it("creates a new migration from an edit with an empty find", () => {
    const { files, problems } = applyEdits(new Map(), [{ file: migration.file, find: "", replace: migration.text }]);
    assert.deepEqual(problems, []);
    assert.equal(files.get(migration.file), migration.text);
  });

  it("creates no other new file", () => {
    const { problems } = applyEdits(new Map(), [{ file: "src/lib/new.ts", find: "", replace: "export {};" }]);
    assert.equal(problems.length, 1);
  });
});

describe("pullRequestText", () => {
  it("warns about a data change and adds the checklist", () => {
    const { body } = pullRequestText(example("inc_price_gap"));
    assert.ok(body.includes("**This fix changes stored data.**"));
    assert.ok(body.includes("`drizzle/0005_backfill_product_prices.sql`, `drizzle/meta/_journal.json` never ran"));
    assert.ok(body.includes("- [ ] Run it against a copy of the production data first"));
    assert.ok(body.includes("· changes stored data"));
  });

  it("says nothing of data for a code-only fix", () => {
    const { body } = pullRequestText(example("inc_pool_leak"));
    assert.ok(!body.includes("stored data"));
  });
});
