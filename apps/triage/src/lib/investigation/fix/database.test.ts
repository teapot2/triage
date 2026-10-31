import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { copyName, databaseUrlFor } from "./database";
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
