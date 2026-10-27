import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { watchPool } from "./pool-watch";
import * as schema from "./schema";

export const DEFAULT_DATABASE_URL = "postgres://triage:triage@localhost:5433/shopfront";

const globalForDb = globalThis as unknown as { shopfrontPool?: Pool };

// Reuse the pool across dev hot reloads.
export const pool =
  globalForDb.shopfrontPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 3000,
  });

if (process.env.NODE_ENV !== "production") globalForDb.shopfrontPool = pool;

watchPool(pool);

export const db = drizzle({ client: pool, schema });
