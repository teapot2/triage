import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db, pool } from "@/db/client";
import { products, stockLevels } from "@/db/schema";
import { getStockLevel } from "@/lib/stock";
import { setFlag } from "@/lib/flags";
import { eq } from "drizzle-orm";

describe("getStockLevelDirect", () => {
  let missingProductId: number;

  beforeAll(async () => {
    setFlag("FF_STOCK_DIRECT_QUERY", true);
    const [row] = await db
      .insert(products)
      .values({
        name: `test-stock-leak-${Date.now()}`,
        priceCents: 100,
        category: "Home",
        description: "test product for stock leak",
        ratingTenths: 45,
        reviewCount: 0,
      })
      .returning({ id: products.id });
    missingProductId = row.id;
    await db.delete(stockLevels).where(eq(stockLevels.productId, missingProductId));
  });

  afterAll(async () => {
    if (missingProductId) {
      await db.delete(products).where(eq(products.id, missingProductId));
    }
    setFlag("FF_STOCK_DIRECT_QUERY", false);
  });

  it("releases DB connection when stock row is missing", async () => {
    await db.select().from(products).limit(1);
    const level = await getStockLevel(missingProductId);
    expect(level).toBe(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(pool.idleCount).toBe(pool.totalCount);
    expect(pool.waitingCount).toBe(0);
    for (let i = 0; i < 5; i++) {
      const v = await getStockLevel(missingProductId);
      expect(v).toBe(0);
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(pool.idleCount).toBe(pool.totalCount);
    expect(pool.waitingCount).toBe(0);
    const client = await pool.connect();
    try {
      const { rows } = await client.query("SELECT 1 as one");
      expect(rows[0].one).toBe(1);
    } finally {
      client.release();
    }
  });
});
