import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { dbQueries, ownQuery } from "../live/live-source";
import { copyName, copyPlan, databaseUrlFor } from "./database";
import { opensOwnConnection } from "./prove";
import { sandboxEnv } from "./sandbox";

const reference = (file: string) => readFile(path.join(import.meta.dirname, file), "utf8");

describe("copyName", () => {
  it("names the copy after the source and what it's for", () => {
    assert.equal(copyName("shopfront", "inc_mvvpdgbb_aba8be-original"), "shopfront_sandbox_inc_mvvpdgbb_aba8be_original");
  });

  it("keeps to Postgres' identifier limit and plain characters", () => {
    const name = copyName("shopfront", `check-sandbox ${"x".repeat(80)}`);
    assert.equal(name.length, 63);
    assert.match(name, /^[a-z0-9_]+$/);
  });
});

describe("databaseUrlFor", () => {
  it("keeps the server, credentials and options, and swaps the database", () => {
    assert.equal(
      databaseUrlFor("postgres://triage:triage@localhost:5433/shopfront?sslmode=disable", "shopfront_sandbox_x"),
      "postgres://triage:triage@localhost:5433/shopfront_sandbox_x?sslmode=disable",
    );
  });
});

describe("copyPlan", () => {
  const t = (table: string, columns: string[]) => ({ schema: "public", table, columns });

  it("copies the columns both sides have, in the copy's order", () => {
    assert.deepEqual(
      copyPlan([t("reviews", ["id", "product_id", "rating", "body"])], [t("reviews", ["body", "rating", "id", "product_id"])]),
      [t("reviews", ["id", "product_id", "rating", "body"])],
    );
  });

  it("leaves a column only one side has to the copy's default, or drops it", () => {
    assert.deepEqual(
      copyPlan([t("products", ["id", "name", "rating_tenths"])], [t("products", ["id", "name", "legacy_code"])]),
      [t("products", ["id", "name"])],
    );
  });

  it("skips a table the source doesn't have yet", () => {
    assert.deepEqual(copyPlan([t("product_prices", ["id"]), t("products", ["id"])], [t("products", ["id"])]), [
      t("products", ["id"]),
    ]);
  });

  it("tells tables apart by schema", () => {
    assert.deepEqual(copyPlan([{ schema: "audit", table: "products", columns: ["id"] }], [t("products", ["id"])]), []);
  });
});

describe("Triage's own queries on the watched database", () => {
  it("are tagged, and slow_queries leaves the tagged ones out", () => {
    const copy = ownQuery(`COPY "public"."reviews" ("id") TO STDOUT`);
    assert.match(copy, /^COPY .* \/\* triage \*\/$/);
    assert.ok(dbQueries.slow_queries.includes("query NOT LIKE '%/* triage */%'"));
  });

  it("leave Triage's connections out of the activity check", () => {
    for (const name of ["triage", "triage-sandbox"]) assert.ok(dbQueries.activity.includes(`'${name}'`));
    assert.match(dbQueries.activity, /application_name NOT IN \(/);
  });
});

describe("sandboxEnv", () => {
  it("points the app's client at the copy and leaves out the real database's address", () => {
    process.env.SHOPFRONT_DATABASE_URL = "postgres://triage:triage@localhost:5433/shopfront";
    try {
      const env = sandboxEnv("postgres://triage:triage@localhost:5433/shopfront_sandbox_x");
      assert.equal(env.DATABASE_URL, "postgres://triage:triage@localhost:5433/shopfront_sandbox_x");
      assert.equal(env.SHOPFRONT_DATABASE_URL, undefined);
      assert.equal(env.CI, "1");
    } finally {
      delete process.env.SHOPFRONT_DATABASE_URL;
    }
  });
});

describe("opensOwnConnection", () => {
  it("turns back a test that connects on its own", () => {
    assert.ok(opensOwnConnection(`const db = drizzle("postgres://triage:triage@localhost:5433/shopfront");`));
    assert.ok(opensOwnConnection(`const pool = new Pool({ connectionString: url });`));
    assert.ok(opensOwnConnection(`const client = new pg.Client();`));
  });

  it("lets through tests that use the app's own client, the reference ones included", async () => {
    assert.ok(!opensOwnConnection(await reference("reference-stock.test.ts.txt")));
    assert.ok(!opensOwnConnection(await reference("reference-prices.test.ts.txt")));
    assert.ok(!opensOwnConnection(`import { db, pool } from "@/db/client";\nconst client = await pool.connect();`));
  });
});
