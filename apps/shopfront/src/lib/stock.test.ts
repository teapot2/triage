import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PoolClient } from "pg";
import { pool } from "@/db/client";
import { setFlag } from "@/lib/flags";
import { getStockLevel } from "@/lib/stock";

describe("getStockLevel", () => {
  let acquired: PoolClient | undefined;
  const onAcquire = (client: PoolClient) => {
    acquired = client;
  };
  beforeAll(() => {
    setFlag("FF_STOCK_DIRECT_QUERY", true);
    pool.on("acquire", onAcquire);
  });
  afterAll(async () => {
    pool.off("acquire", onAcquire);
    const leaked = pool.totalCount - pool.idleCount;
    if (leaked > 0 && acquired !== undefined) {
      acquired.release();
    }
    setFlag("FF_STOCK_DIRECT_QUERY", false);
    await pool.end();
  });
  it("releases the pooled client when the stock row is missing", async () => {
    acquired = undefined;
    const missingId = -1;
    const beforeCheckedOut = pool.totalCount - pool.idleCount;
    const level = await getStockLevel(missingId);
    expect(level).toBe(0);
    const afterCheckedOut = pool.totalCount - pool.idleCount;
    expect(afterCheckedOut).toBe(beforeCheckedOut);
  });
});
