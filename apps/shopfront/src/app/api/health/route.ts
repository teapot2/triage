import { sql } from "drizzle-orm";
import { db, pool } from "@/db/client";
import { flagStates } from "@/lib/flags";

export const dynamic = "force-dynamic";

// pool: the pg pool's own counts, read before the probe query so they show
// the state that query met. If the pool runs out, `checkedOut` sits at `max`
// and `waiting` climbs while the probe times out.
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
  return Response.json({ ok: dbOk, db: dbOk, pool: counts, flags }, { status: dbOk ? 200 : 503 });
}
