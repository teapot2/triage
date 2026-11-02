import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type QueryResult } from "pg";
import { logger } from "@/lib/logger";
import { watchPool } from "./pool-watch";
import * as schema from "./schema";

export const DEFAULT_DATABASE_URL = "postgres://triage:triage@localhost:5433/shopfront";

type Stats = { queries: number; rows: number };

const globalForDb = globalThis as unknown as { shopfrontPool?: Pool; shopfrontQueryStats?: Stats };

function createPool() {
  const created = new Pool({
    connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 3000,
  });
  // Build workers open pools too, to collect page data; only the server's counts.
  if (process.env.NEXT_PHASE !== "phase-production-build") {
    logger.info("db: pool created", { "db.pool.max": created.options.max, "db.pool.connect_timeout_ms": created.options.connectionTimeoutMillis });
  }
  // An idle client the server dropped; the pool replaces it, so this is
  // worth knowing about but not fatal.
  created.on("error", (err) => logger.error("db: idle client error", { "error.message": err.message }));
  return created;
}

// One pool per process: shared across dev hot reloads, and between the
// server's bundles in production (the instrumentation hook and the routes
// load this module separately).
export const pool = globalForDb.shopfrontPool ?? createPool();
globalForDb.shopfrontPool = pool;

watchPool(pool);

// Queries sent and rows they returned since the server started, for
// /api/health. Kept across hot reloads like the pool.
const stats = (globalForDb.shopfrontQueryStats ??= { queries: 0, rows: 0 });
export const queriesIssued = () => stats.queries;
export const rowsFetched = () => stats.rows;

// Drizzle sends its queries through pool.query; each result's rows are
// added up as it arrives. Wrapped once per pool, so a hot reload, which
// keeps the pool, doesn't wrap it again.
const counted = Symbol.for("shopfront.rowsCounted");
const marked = pool as Pool & { [counted]?: true };
if (!marked[counted]) {
  marked[counted] = true;
  const query = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  pool.query = ((...args: unknown[]) => {
    const result = query(...args);
    if (result instanceof Promise) {
      result.then(
        (r: QueryResult) => void (stats.rows += Array.isArray(r?.rows) ? r.rows.length : 0),
        () => undefined,
      );
    }
    return result;
  }) as typeof pool.query;
}

export const db = drizzle({
  client: pool,
  schema,
  logger: {
    logQuery() {
      stats.queries++;
    },
  },
});
