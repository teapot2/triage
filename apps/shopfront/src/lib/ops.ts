import { pool } from "@/db/client";
import { heldFor, STUCK_AFTER_MS } from "@/db/pool-watch";
import { flagStates, type FeatureFlag } from "@/lib/flags";
import { trafficSnapshot } from "@/lib/traffic";

// The demo controls are for local runs and demos. In a production build they
// are off unless OPS_ENABLED=1, so a deployed store doesn't ship a "break
// the database" button.
export const opsEnabled = () => process.env.NODE_ENV !== "production" || process.env.OPS_ENABLED === "1";

// What each flag does to the store, for whoever runs the demo. It lives here
// with the other demo controls, not in lib/flags.ts: the store's own code
// reads like any team's, so Triage, which reads that code, has to find the
// bug the way it would in a real app. Triage can't read this file.
const faults: Record<FeatureFlag, { label: string; description: string }> = {
  FF_STOCK_DIRECT_QUERY: {
    label: "Connection pool leak",
    description:
      "getStockLevel switches to a direct query that keeps its pooled connection when a product has no stock row. " +
      "About ten views of such a product use up the pool, then every database-backed page times out after 3 s.",
  },
};

// Everything /ops shows. In-memory only, no database query: it has to answer
// while the pool is jammed.
export function opsState() {
  const held = heldFor();
  return {
    flags: flagStates().map((f) => ({ ...f, ...faults[f.name] })),
    pool: {
      max: pool.options.max ?? 10,
      checkedOut: pool.totalCount - pool.idleCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
      held,
      stuck: held.filter((ms) => ms >= STUCK_AFTER_MS).length,
      stuckAfterMs: STUCK_AFTER_MS,
    },
    traffic: trafficSnapshot(),
  };
}

export type OpsState = ReturnType<typeof opsState>;
