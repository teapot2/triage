// Checks the fix sandbox end to end without the model: proves a known-good
// fix for Shopfront's planted bug (the reference test plus a try/finally
// around the pooled client) and prints each run. Needs Postgres up.
//
//   pnpm --filter @triage/web check:sandbox

import { readFile } from "node:fs/promises";
import path from "node:path";
import { proveFix } from "../src/lib/investigation/fix/prove";
import { shopfrontDir } from "../src/lib/investigation/live/live-source";

async function main() {
  const content = await readFile(path.join(__dirname, "../src/lib/investigation/fix/reference-stock.test.ts.txt"), "utf8");
  const proof = await proveFix({
    appDir: shopfrontDir,
    name: "check-sandbox",
    test: {
      file: "src/lib/stock.test.ts",
      name: "returns every pooled connection when a product has no stock row",
      content,
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
    onStage: (stage) => console.log(`check:sandbox: running ${stage}…`),
  });

  for (const r of proof.runs) {
    console.log(`\n== ${r.label}: exit ${r.exitCode} in ${r.durationMs} ms ==`);
    for (const t of r.tests) console.log(`  ${t.status} ${t.name}${t.error ? ` (${t.error})` : ""}`);
  }
  if (proof.ok) {
    console.log(`\n${proof.patch}\n\ncheck:sandbox: proven (${proof.files.join(", ")}).`);
  } else {
    console.error(`\ncheck:sandbox: not proven:\n${proof.problems.join("\n")}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`check:sandbox failed: ${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 1;
});
