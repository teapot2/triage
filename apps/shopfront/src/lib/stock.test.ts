import { describe, it, expect } from "vitest";
import { pool } from "@/db/client";
import { setFlag } from "@/lib/flags";
import { getStockLevel } from "@/lib/stock";

describe("getStockLevelDirect pool leak", () => {
  it("releases pooled client when stock row is missing", async () => {
    setFlag("FF_STOCK_DIRECT_QUERY", true);
    try {
      const missingId = 999999;
      const initialTotal = pool.totalCount;
      for (let i = 0; i < 5; i++) {
        const level = await getStockLevel(missingId);
        expect(level).toBe(0);
      }
      expect(pool.totalCount - pool.idleCount).toBe(0);
      expect(pool.totalCount - initialTotal).toBeLessThan(3);
    } finally {
      setFlag("FF_STOCK_DIRECT_QUERY", false);
    }
  });
});
