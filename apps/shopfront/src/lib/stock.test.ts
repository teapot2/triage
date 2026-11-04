import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "@/db/client";
import { products, stockLevels } from "@/db/schema";
import { getStockLevel } from "@/lib/stock";
import { setFlag } from "@/lib/flags";

describe("getStockLevelDirect connection handling", () => {
  let missingId: number;
  let testName: string;

  beforeAll(async () => {
    setFlag("FF_STOCK_DIRECT_QUERY", true);
    testName = `__test_no_stock_${Date.now()}`;
    const [row] = await db
      .insert(products)
      .values({ name: testName, priceCents: 1000 })
      .returning({ id: products.id });
    missingId = row.id;
    await db.delete(stockLevels).where(eq(stockLevels.productId, missingId));
  });

  afterAll(async () => {
    if (testName) {
      await db.delete(products).where(eq(products.name, testName));
    }
    setFlag("FF_STOCK_DIRECT_QUERY", false);
  });

  it("releases DB connection when stock row is missing with direct query enabled", async () => {
    await pool.query("SELECT 1");
    const usedBefore = pool.totalCount - pool.idleCount;
    const result = await getStockLevel(missingId);
    expect(result).toBe(0);
    const usedAfter = pool.totalCount - pool.idleCount;
    expect(usedAfter).toBe(usedBefore);
    const result2 = await getStockLevel(missingId);
    expect(result2).toBe(0);
    const usedAfter2 = pool.totalCount - pool.idleCount;
    expect(usedAfter2).toBe(usedBefore);
  });
});
