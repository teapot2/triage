import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exampleIncidents } from "../fixtures";
import { repeatsDenied } from "./feedback";
import { planMigration } from "./migration";
import type { Edit } from "./prove";

// Shopfront's journal once the price list's own migration (0004) is in.
const entries = [
  { idx: 0, version: "7", when: 1792793054202, tag: "0000_omniscient_satana", breakpoints: true },
  { idx: 1, version: "7", when: 1793029074714, tag: "0001_flawless_sage", breakpoints: true },
  { idx: 2, version: "7", when: 1793030023886, tag: "0002_tired_stature", breakpoints: true },
  { idx: 3, version: "7", when: 1793046307619, tag: "0003_pg_stat_statements", breakpoints: true },
  { idx: 4, version: "7", when: 1793401492714, tag: "0004_product_prices", breakpoints: true },
];
const journal = JSON.stringify({ version: "7", dialect: "postgresql", entries }, null, 2);
const NOW = 1793500000000;

const code: Edit = { file: "src/lib/prices.ts", find: ".innerJoin(stockLevels, eq(stockLevels.productId, products.id))", replace: "" };
const backfill = `INSERT INTO "product_prices" ("product_id", "amount_cents")
SELECT "id", "price_cents" FROM "products"
ON CONFLICT ("product_id") DO NOTHING;`;
const migration = (file: string, replace = backfill): Edit => ({ file, find: "", replace });
const existing = new Set(["src/lib/prices.ts"]);

const parse = (text: string | undefined) => JSON.parse(text!) as { entries: typeof entries };

describe("planMigration", () => {
  it("leaves the journal alone for a fix with no new migration", () => {
    const edits = [code];
    const plan = planMigration(edits, existing, journal, NOW);
    assert.equal(plan.journal, undefined);
    assert.equal(plan.edits, edits);
    assert.deepEqual(plan.problems, []);
  });

  it("leaves it alone for an edit to an existing migration", () => {
    const edit: Edit = { file: "drizzle/0004_product_prices.sql", find: "NOT NULL", replace: "NOT NULL DEFAULT 0" };
    const plan = planMigration([edit], new Set([edit.file]), journal, NOW);
    assert.equal(plan.journal, undefined);
    assert.deepEqual(plan.problems, []);
  });

  it("adds the next entry, copying version and breakpoints from the last", () => {
    const plan = planMigration([code, migration("drizzle/0005_backfill_product_prices.sql")], existing, journal, NOW);
    assert.deepEqual(plan.problems, []);
    assert.deepEqual(parse(plan.journal).entries, [
      ...entries,
      { idx: 5, version: "7", when: NOW, tag: "0005_backfill_product_prices", breakpoints: true },
    ]);
    assert.deepEqual(
      plan.edits.map((e) => e.file),
      ["src/lib/prices.ts", "drizzle/0005_backfill_product_prices.sql"],
    );
  });

  it("keeps the file's formatting, so the diff is only the new entry", () => {
    const plan = planMigration([migration("drizzle/0005_backfill.sql")], existing, journal, NOW);
    assert.ok(plan.journal!.startsWith(journal.slice(0, -"\n  ]\n}".length)));
    assert.ok(!plan.journal!.endsWith("\n"));
    const crlf = `${journal.replace(/\n/g, "\r\n")}\r\n`;
    const fromCrlf = planMigration([migration("drizzle/0005_backfill.sql")], existing, crlf, NOW).journal!;
    assert.ok(fromCrlf.endsWith("}\r\n"));
    assert.ok(!/[^\r]\n/.test(fromCrlf));
  });

  it("renames a misnumbered or unnumbered migration to the next number", () => {
    for (const file of ["drizzle/0004_backfill_product_prices.sql", "drizzle/backfill_product_prices.sql", "drizzle/12_backfill_product_prices.sql"]) {
      const followUp: Edit = { file, find: "DO NOTHING;", replace: "DO NOTHING; -- idempotent" };
      const plan = planMigration([code, migration(file), followUp], existing, journal, NOW);
      assert.deepEqual(plan.problems, [], file);
      assert.deepEqual(
        plan.edits.map((e) => e.file),
        ["src/lib/prices.ts", "drizzle/0005_backfill_product_prices.sql", "drizzle/0005_backfill_product_prices.sql"],
        file,
      );
      assert.equal(parse(plan.journal).entries.at(-1)?.tag, "0005_backfill_product_prices");
    }
  });

  it("sends back a migration with no name to keep", () => {
    const plan = planMigration([migration("drizzle/0005.sql")], existing, journal, NOW);
    assert.equal(plan.journal, undefined);
    assert.match(plan.problems[0], /name the migration drizzle\/<number>_<words>\.sql/);
  });

  it("never dates an entry before the last one, or Drizzle would skip it", () => {
    const plan = planMigration([migration("drizzle/0005_backfill.sql")], existing, journal, entries[4].when - 60_000);
    assert.equal(parse(plan.journal).entries.at(-1)?.when, entries[4].when + 1);
  });

  it("starts at 0000 in an empty journal", () => {
    const empty = JSON.stringify({ version: "7", dialect: "postgresql", entries: [] }, null, 2);
    const plan = planMigration([migration("drizzle/backfill.sql")], existing, empty, NOW);
    assert.deepEqual(parse(plan.journal).entries, [{ idx: 0, version: "7", when: NOW, tag: "0000_backfill", breakpoints: true }]);
    assert.equal(plan.edits[0].file, "drizzle/0000_backfill.sql");
  });

  it("allows one new migration per fix", () => {
    const plan = planMigration([migration("drizzle/0005_a.sql"), migration("drizzle/0006_b.sql")], existing, journal, NOW);
    assert.equal(plan.journal, undefined);
    assert.match(plan.problems[0], /adds 2 migrations/);
  });

  it("sends back a migration that changes the schema", () => {
    const plan = planMigration([migration("drizzle/0005_x.sql", 'ALTER TABLE "products" ADD COLUMN "x" integer;')], existing, journal, NOW);
    assert.equal(plan.journal, undefined);
    assert.match(plan.problems[0], /changes the schema \(ALTER\)/);
  });

  it("says so when there is no journal to register it in", () => {
    const plan = planMigration([migration("drizzle/0005_x.sql")], existing, undefined, NOW);
    assert.match(plan.problems[0], /_journal\.json is missing or unreadable/);
  });
});

describe("repeatsDenied", () => {
  it("ignores the journal entry's timestamp: the same fix again is still a repeat", () => {
    const patch = exampleIncidents.find((i) => i.id === "inc_price_gap")!.fix!.patch;
    const later = patch.replace(/"when": \d+/g, (m) => (m.endsWith("715") ? '"when": 1793999999999' : m));
    assert.notEqual(later, patch);
    assert.equal(repeatsDenied(later, [{ reason: "no", patch }]), 1);
  });
});
