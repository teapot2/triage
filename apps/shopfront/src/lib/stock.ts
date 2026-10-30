import { eq } from "drizzle-orm";
import { db, pool } from "@/db/client";
import { stockLevels } from "@/db/schema";
import { isEnabled } from "@/lib/flags";
import { logger } from "@/lib/logger";

// Below this many units the buy box says how many are left.
export const LOW_STOCK = 10;

// A product with no stock row hasn't been stocked yet: it shows as sold out
// rather than as an error.
const DEFAULT_STOCK = 0;

export type StockStatus = "in_stock" | "low" | "sold_out";

export const stockStatus = (onHand: number): StockStatus =>
  onHand <= 0 ? "sold_out" : onHand < LOW_STOCK ? "low" : "in_stock";

// Units on hand for one product. Product pages call this on every view, so
// FF_STOCK_DIRECT_QUERY trials a leaner query for it.
export async function getStockLevel(productId: number): Promise<number> {
  return isEnabled("FF_STOCK_DIRECT_QUERY") ? getStockLevelDirect(productId) : getStockLevelOrm(productId);
}

async function getStockLevelOrm(productId: number): Promise<number> {
  const [row] = await db
    .select({ onHand: stockLevels.onHand })
    .from(stockLevels)
    .where(eq(stockLevels.productId, productId))
    .limit(1);
  if (!row) {
    logger.info("stock row missing, returning default", { "product.id": productId });
    return DEFAULT_STOCK;
  }
  return row.onHand;
}

// One parameterised query on a pooled client, skipping Drizzle's query
// building.
async function getStockLevelDirect(productId: number): Promise<number> {
  const client = await pool.connect();
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
  }
}
