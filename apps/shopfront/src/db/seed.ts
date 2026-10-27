import { eq, notInArray } from "drizzle-orm";
import { catalog, openingStock } from "@/lib/catalog";
import { db, pool } from "./client";
import { products, stockLevels } from "./schema";

// Makes the products table match the catalog: inserts new products, updates
// the ones that exist (by name), and removes products no longer in it, such
// as the placeholder apparel from before the store had a brand. Stock is
// reset to the opening levels each time.
async function main() {
  const names = catalog.map((p) => p.name);
  const removed = await db.delete(products).where(notInArray(products.name, names)).returning({ id: products.id });

  for (const { name, ...details } of catalog) {
    const [row] = await db
      .insert(products)
      .values({ name, ...details })
      .onConflictDoUpdate({ target: products.name, set: details })
      .returning({ id: products.id });
    const onHand = openingStock[name];
    if (onHand === undefined) {
      // Unstocked on purpose (see openingStock): no row.
      await db.delete(stockLevels).where(eq(stockLevels.productId, row.id));
      continue;
    }
    await db
      .insert(stockLevels)
      .values({ productId: row.id, onHand })
      .onConflictDoUpdate({ target: stockLevels.productId, set: { onHand, updatedAt: new Date() } });
  }
  console.log(`seed: ${catalog.length} product(s) in the catalog, ${removed.length} removed, stock reset`);
}

main()
  .catch((err) => {
    console.error("seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
