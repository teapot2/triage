import { count, lt } from "drizzle-orm";
import { db } from "@/db/client";
import { stockLevels } from "@/db/schema";
import { logger } from "@/lib/logger";
import { LOW_STOCK } from "@/lib/stock";

// Housekeeping that runs on a timer inside the server, small enough not to
// need a worker of its own: a sweep that counts the products running low,
// so the reorder list is ready when the team looks. Timers live on
// globalThis so dev hot reloads don't start a second set, and are unref'd
// so they never keep the process alive.

const FIRST_SWEEP_MS = 20_000;
const SWEEP_EVERY_MS = 2 * 60_000;

const globalForJobs = globalThis as unknown as { shopfrontJobs?: true };

async function lowStockSweep() {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  try {
    const [{ low }] = await db.select({ low: count() }).from(stockLevels).where(lt(stockLevels.onHand, LOW_STOCK));
    logger.info("stock: low-stock sweep done", { "stock.low_count": low, duration_ms: elapsed() });
  } catch (err) {
    logger.error("stock: low-stock sweep failed", { "error.message": String(err), duration_ms: elapsed() });
  }
}

export function startJobs() {
  if (globalForJobs.shopfrontJobs) return;
  globalForJobs.shopfrontJobs = true;
  setTimeout(() => {
    void lowStockSweep();
    setInterval(() => void lowStockSweep(), SWEEP_EVERY_MS).unref();
  }, FIRST_SWEEP_MS).unref();
  logger.info("jobs: scheduled", { "jobs.low_stock_sweep.every_ms": SWEEP_EVERY_MS });
}
