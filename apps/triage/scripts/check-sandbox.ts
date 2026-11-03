// Checks the fix sandbox end to end without the model: proves a known-good
// fix for each of Shopfront's planted bugs (the reference test plus the
// fix) and prints each run, and proves one for the formatted-price release
// against the release's commit rather than the checkout, as the fix stage
// does after a rollback. The price list's test writes rows, so the check
// also compares the real database before and after: the tests must only
// have changed their throwaway copies. Needs Postgres up. A word on the
// command line keeps to the cases whose label has it.
//
//   pnpm --filter @triage/web check:sandbox
//   pnpm --filter @triage/web check:sandbox formatted

import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { type Edit, proveFix, type RegressionTest } from "../src/lib/investigation/fix/prove";
import { hasCommit } from "../src/lib/investigation/fix/release-tree";
import { shopfrontDatabaseUrl, shopfrontDir } from "../src/lib/investigation/live/live-source";

const reference = (file: string) => readFile(path.join(__dirname, "../src/lib/investigation/fix", file), "utf8");

// The edits are written with LF; a checkout with CRLF line endings
// (core.autocrlf on Windows) needs them in its own.
async function withEndings(edits: Edit[]): Promise<Edit[]> {
  const out: Edit[] = [];
  for (const e of edits) {
    const crlf = (await readFile(path.join(shopfrontDir, e.file), "utf8")).includes("\r\n");
    const fix = (t: string) => (crlf ? t.replaceAll("\n", "\r\n") : t);
    out.push({ ...e, find: fix(e.find), replace: fix(e.replace) });
  }
  return out;
}

// `releaseSha`: proven against that commit's tree, as a rolled-back
// release's fix is; its edits are written for the committed files (LF).
const cases = async (): Promise<{ label: string; test: RegressionTest; edits: Edit[]; releaseSha?: string }[]> => [
  {
    label: "pool leak",
    test: {
      file: "src/lib/stock.test.ts",
      name: "returns every pooled connection when a product has no stock row",
      content: await reference("reference-stock.test.ts.txt"),
    },
    edits: [
      {
        file: "src/lib/stock.ts",
        find: `  const client = await pool.connect();
  const { rows } = await client.query<{ on_hand: number }>(
    "SELECT on_hand FROM stock_levels WHERE product_id = $1",
    [productId],
  );
  if (rows.length === 0) {
    logger.info("stock row missing, returning default", { "product.id": productId });
    return DEFAULT_STOCK;
  }
  client.release();
  return rows[0].on_hand;`,
        replace: `  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ on_hand: number }>(
      "SELECT on_hand FROM stock_levels WHERE product_id = $1",
      [productId],
    );
    if (rows.length === 0) {
      logger.info("stock row missing, returning default", { "product.id": productId });
      return DEFAULT_STOCK;
    }
    return rows[0].on_hand;
  } finally {
    client.release();
  }`,
      },
    ],
  },
  {
    label: "price list gap",
    test: {
      file: "src/lib/prices.test.ts",
      name: "gives every product a list price after a sync, stocked or not",
      content: await reference("reference-prices.test.ts.txt"),
    },
    edits: [
      {
        file: "src/lib/prices.ts",
        find: `import { productPrices, products, stockLevels, type Product } from "@/db/schema";`,
        replace: `import { productPrices, products, type Product } from "@/db/schema";`,
      },
      {
        file: "src/lib/prices.ts",
        find: `// updating changed prices. Only products we sell get a list price, so it
// takes the products inventory carries.`,
        replace: `// updating changed prices. Every product gets one, stocked or not: the
// product page and the cart price any product they show.`,
      },
      {
        file: "src/lib/prices.ts",
        find: `        .from(products)
        .innerJoin(stockLevels, eq(stockLevels.productId, products.id)),`,
        replace: `        .from(products),`,
      },
    ],
  },
  {
    label: "live ratings loop",
    test: {
      file: "src/lib/ratings.test.ts",
      name: "rates every listed product with one query, a row per product",
      content: await reference("reference-ratings.test.ts.txt"),
    },
    edits: [
      {
        file: "src/lib/ratings.ts",
        find: `import { eq, inArray } from "drizzle-orm";`,
        replace: `import { avg, count, inArray } from "drizzle-orm";`,
      },
      {
        file: "src/lib/ratings.ts",
        find: `  for (const id of productIds) {
    const rows = await db.select({ rating: reviews.rating }).from(reviews).where(eq(reviews.productId, id));
    const total = rows.reduce((sum, r) => sum + r.rating, 0);
    ratings.set(id, {
      ratingTenths: rows.length ? Math.round((total / rows.length) * 10) : 0,
      reviewCount: rows.length,
    });
  }
  return ratings;`,
        replace: `  // One query for all the listed products, averaged and counted in the
  // database.
  const rows = await db
    .select({ productId: reviews.productId, average: avg(reviews.rating), reviewCount: count() })
    .from(reviews)
    .where(inArray(reviews.productId, productIds))
    .groupBy(reviews.productId);
  for (const { productId, average, reviewCount } of rows) {
    ratings.set(productId, { ratingTenths: Math.round(Number(average) * 10), reviewCount });
  }
  return ratings;`,
      },
    ],
  },
  {
    label: "formatted price (release 0dfdbac)",
    releaseSha: "0dfdbac",
    test: {
      file: "src/lib/money.test.ts",
      name: "formats in US dollars when STORE_CURRENCY is unset",
      content: await reference("reference-money.test.ts.txt"),
    },
    edits: [
      {
        file: "src/lib/money.ts",
        find: `export function formatPrice(cents: number, currency = process.env.STORE_CURRENCY): string {`,
        replace: `export function formatPrice(cents: number, currency = process.env.STORE_CURRENCY || "USD"): string {`,
      },
    ],
  },
];

// What a test could have changed in the real database: every table's rows
// and every sequence's position.
async function snapshot(): Promise<string> {
  const client = new Client({ connectionString: shopfrontDatabaseUrl });
  await client.connect();
  try {
    const { rows: tables } = await client.query<{ name: string }>(
      "SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1",
    );
    const parts: string[] = [];
    for (const { name } of tables) {
      const { rows } = await client.query(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS h FROM ${name} t`);
      parts.push(`${name} ${rows[0].h}`);
    }
    const { rows: sequences } = await client.query(
      "SELECT format('%I.%I', schemaname, sequencename) AS name, last_value FROM pg_sequences ORDER BY 1",
    );
    for (const s of sequences) parts.push(`${s.name} ${s.last_value}`);
    return parts.join("\n");
  } finally {
    await client.end();
  }
}

async function leftoverCopies(): Promise<string[]> {
  const client = new Client({ connectionString: shopfrontDatabaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE '%\\_sandbox\\_check\\_sandbox%'",
    );
    return rows.map((r) => r.datname);
  } finally {
    await client.end();
  }
}

async function main() {
  const only = process.argv[2];
  const before = await snapshot();
  for (const c of await cases()) {
    if (only && !c.label.includes(only)) continue;
    console.log(`\n# ${c.label}`);
    if (c.releaseSha && !(await hasCommit(shopfrontDir, c.releaseSha))) {
      console.log(`check:sandbox: commit ${c.releaseSha} isn't in this checkout; skipped.`);
      continue;
    }
    const proof = await proveFix({
      appDir: shopfrontDir,
      name: "check-sandbox",
      releaseSha: c.releaseSha,
      test: c.test,
      edits: c.releaseSha ? c.edits : await withEndings(c.edits),
      onStage: (stage) => console.log(`check:sandbox: running ${stage}…`),
    });
    for (const r of proof.runs) {
      console.log(`\n== ${r.label}: exit ${r.exitCode} in ${r.durationMs} ms ==`);
      for (const t of r.tests) console.log(`  ${t.status} ${t.name}${t.error ? ` (${t.error})` : ""}`);
    }
    if (proof.ok) {
      console.log(`\n${proof.patch}\n\ncheck:sandbox: ${c.label} proven (${proof.files.join(", ")}).`);
    } else {
      console.error(`\ncheck:sandbox: ${c.label} not proven:\n${proof.problems.join("\n")}`);
      process.exitCode = 1;
    }
  }

  const after = await snapshot();
  if (after !== before) {
    console.error(`\ncheck:sandbox: the real database changed.\nbefore:\n${before}\nafter:\n${after}`);
    process.exitCode = 1;
  } else console.log("\ncheck:sandbox: the real database is unchanged.");
  const left = await leftoverCopies();
  if (left.length) {
    console.error(`check:sandbox: copies left behind: ${left.join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`check:sandbox failed: ${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 1;
});
