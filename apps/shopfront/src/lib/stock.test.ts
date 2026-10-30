import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "@/db/client";
import { isEnabled, setFlag } from "@/lib/flags";
import { getStockLevel } from "@/lib/stock";

describe("getStockLevel direct query", () => {
  let wasEnabled: boolean;
  beforeAll(() => {
    wasEnabled = isEnabled("FF_STOCK_DIRECT_QUERY");
    setFlag("FF_STOCK_DIRECT_QUERY", true);
  });
  afterAll(() => {
    setFlag("FF_STOCK_DIRECT_QUERY", wasEnabled);
  });
  it("releases pooled connection when stock row is missing", async () => {
    const missingId = -1;
    const beforeCheckedOut = pool.totalCount - pool.idleCount;
    const level = await getStockLevel(missingId);
    expect(level).toBe(0);
    const afterCheckedOut = pool.totalCount - pool.idleCount;
    expect(afterCheckedOut).toBe(beforeCheckedOut);
  });
});
