import type { Pool, PoolClient } from "pg";

// Ops-side bookkeeping for the pg pool: when each checked-out client was
// taken, from pg-pool's own acquire/release events. It lets /ops show how
// long connections have been held and hand back the ones held far longer
// than any request here takes, which is what a restart would do, without
// one. Not part of the app's query path.

// No request in this app holds a connection anywhere near this long; Drizzle
// releases right after each query.
export const STUCK_AFTER_MS = 5000;

type Watch = { held: Map<PoolClient, number> };
const globalForWatch = globalThis as unknown as { shopfrontPoolWatch?: Watch };

// Once per pool, even across dev hot reloads (the pool itself survives them).
export function watchPool(pool: Pool) {
  if (globalForWatch.shopfrontPoolWatch) return;
  const watch: Watch = { held: new Map() };
  globalForWatch.shopfrontPoolWatch = watch;
  pool.on("acquire", (client) => watch.held.set(client, Date.now()));
  pool.on("release", (_err, client) => watch.held.delete(client));
  pool.on("remove", (client) => watch.held.delete(client));
}

const held = () => globalForWatch.shopfrontPoolWatch?.held ?? new Map<PoolClient, number>();

// How long each checked-out connection has been held, longest first.
export function heldFor(now = Date.now()) {
  return [...held().values()].map((since) => now - since).sort((a, b) => b - a);
}

// Hands back connections held past STUCK_AFTER_MS. Returns how many.
export function releaseStuck(now = Date.now()) {
  let released = 0;
  for (const [client, since] of held()) {
    if (now - since < STUCK_AFTER_MS) continue;
    client.release();
    released++;
  }
  return released;
}
