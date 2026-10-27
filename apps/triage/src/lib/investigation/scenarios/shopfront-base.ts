import type { CommitRecord } from "../source";
import { minutesBefore } from "./scenario-source";

// Shopfront as it looks in the scenarios: a trimmed copy of the real app
// (apps/shopfront), with the same file paths, table and column names, and
// getStockLevel as the code the pool-leak fault plants (src/lib/stock.ts).

export const services = [
  { name: "shopfront", dependsOn: ["postgres"] },
  { name: "postgres", dependsOn: [] },
];

export const stockLeaky = `import { pool } from "@/db/client";
import { logger } from "@/lib/logger";

const DEFAULT_STOCK = 0;

// Stock lives in its own table; products without a row default to 0.
export async function getStockLevel(productId: number): Promise<number> {
  const client = await pool.connect();
  const { rows } = await client.query(
    "SELECT on_hand FROM stock_levels WHERE product_id = $1",
    [productId],
  );
  if (rows.length === 0) {
    logger.info("stock row missing, returning default", { "product.id": productId });
    return DEFAULT_STOCK;
  }
  client.release();
  return rows[0].on_hand;
}
`;

export const stockFixed = `import { pool } from "@/db/client";
import { logger } from "@/lib/logger";

const DEFAULT_STOCK = 0;

// Stock lives in its own table; products without a row default to 0.
export async function getStockLevel(productId: number): Promise<number> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
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
`;

export const commonFiles: Record<string, string> = {
  "src/db/client.ts": `import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
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

export const db = drizzle({ client: pool, schema });
`,
  "src/db/schema.ts": `import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  priceCents: integer("price_cents").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const stockLevels = pgTable("stock_levels", {
  productId: integer("product_id")
    .primaryKey()
    .references(() => products.id, { onDelete: "cascade" }),
  onHand: integer("on_hand").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
`,
  "src/app/api/products/route.ts": `import { db } from "@/db/client";
import { products } from "@/db/schema";
import { logger } from "@/lib/logger";

export async function GET() {
  const rows = await db.select().from(products).limit(50);
  logger.info("listed products", { "products.count": rows.length });
  return Response.json(rows);
}
`,
  "src/app/api/products/[id]/route.ts": `import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { products } from "@/db/schema";
import { getStockLevel } from "@/lib/stock";
import { logger } from "@/lib/logger";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await ctx.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "invalid id" }, { status: 400 });
  }

  const [product] = await db.select().from(products).where(eq(products.id, id)).limit(1);
  logger.info("fetched product", { "product.id": id, "product.found": Boolean(product) });

  if (!product) return Response.json({ error: "not found" }, { status: 404 });
  const stockLevel = await getStockLevel(id);
  return Response.json({ ...product, stockLevel });
}
`,
  "src/lib/logger.ts": `import { logs, SeverityNumber, type Attributes } from "@opentelemetry/api";

const otelLogger = logs.getLogger("shopfront");

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, message: string, attributes?: Attributes) {
  otelLogger.emit({ severityNumber: SeverityNumber[level.toUpperCase() as "INFO"], body: message, attributes });
}

export const logger = {
  info: (msg: string, attrs?: Attributes) => emit("info", msg, attrs),
  warn: (msg: string, attrs?: Attributes) => emit("warn", msg, attrs),
  error: (msg: string, attrs?: Attributes) => emit("error", msg, attrs),
};
`,
};

export function commonCommits(now: string): CommitRecord[] {
  return [
    {
      sha: "7d02e11",
      author: "sebastian",
      message: "chore: bump drizzle-orm to 0.45.4",
      files: ["package.json", "pnpm-lock.yaml"],
      committedAt: minutesBefore(now, 60 * 22),
    },
    {
      sha: "3c9f0aa",
      author: "sebastian",
      message: "feat: product detail endpoint",
      files: ["src/app/api/products/[id]/route.ts"],
      committedAt: minutesBefore(now, 60 * 49),
    },
  ];
}
