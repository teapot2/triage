import { sql } from "drizzle-orm";
import { db, pool, queriesIssued, rowsFetched } from "@/db/client";
import { flagStates } from "@/lib/flags";
import { runtimeInfo } from "@/lib/runtime";

export const dynamic = "force-dynamic";

// pool: the pg pool's own counts, read before the probe query so they show
// the state that query met. If the pool runs out, `checkedOut` sits at `max`
// and `waiting` climbs while the probe times out. queries and rows: how
// many queries the app has sent since it started, and the rows they
// returned, this probe included.
export async function GET() {
  const counts = {
    max: pool.options.max,
    total: pool.totalCount,
    idle: pool.idleCount,
    checkedOut: pool.totalCount - pool.idleCount,
    waiting: pool.waitingCount,
  };
  let dbOk = false;
  try {
    await db.execute(sql`select 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }
  const flags = Object.fromEntries(flagStates().map((f) => [f.name, f.enabled]));
  return Response.json(
    { ok: dbOk, db: dbOk, pool: counts, queries: queriesIssued(), rows: rowsFetched(), flags, runtime: runtimeInfo() },
    { status: dbOk ? 200 : 503 },
  );
}
