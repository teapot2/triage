import { proposeMitigation } from "./mitigation/propose";
import { type Incident, incidentSchema, type MetricPoint } from "./schema";

// Mock incidents for building the UI before the agent exists. Parsed through
// the schema at load, so a fixture that drifts from the contract fails fast.

function series(start: string, values: number[]): MetricPoint[] {
  const t0 = Date.parse(start);
  return values.map((value, i) => ({
    t: new Date(t0 + i * 60_000).toISOString(),
    value,
  }));
}

// From 01:56, so the 01:58 deploy shows on the chart before the climb.
const p95Values = [
  117, 120, 119, 115, 123, 118, 118, 121, 116, 124, 119, 122, 140, 310, 820, 1650, 2410, 2890, 2950, 3004, 2980,
  2995, 3002, 2970,
];

const poolLeakPatch = `--- a/src/lib/stock.ts
+++ b/src/lib/stock.ts
@@ -6,13 +6,16 @@ const DEFAULT_STOCK = 0;
 export async function getStockLevel(productId: number): Promise<number> {
   const client = await pool.connect();
-  const { rows } = await client.query(
-    "SELECT on_hand FROM stock_levels WHERE product_id = $1",
-    [productId],
-  );
-  if (rows.length === 0) {
-    logger.info("stock row missing, returning default", { "product.id": productId });
-    return DEFAULT_STOCK;
-  }
-  client.release();
-  return rows[0].on_hand;
+  try {
+    const { rows } = await client.query(
+      "SELECT on_hand FROM stock_levels WHERE product_id = $1",
+      [productId],
+    );
+    if (rows.length === 0) {
+      logger.info("stock row missing, returning default", { "product.id": productId });
+      return DEFAULT_STOCK;
+    }
+    return rows[0].on_hand;
+  } finally {
+    client.release();
+  }
 }
--- /dev/null
+++ b/src/lib/stock.test.ts
@@ -0,0 +1,11 @@
+import { expect, test } from "vitest";
+import { pool } from "@/db/client";
+import { getStockLevel } from "./stock";
+
+test("releases the client when the stock row is missing", async () => {
+  const before = pool.totalCount - pool.idleCount;
+  for (let i = 0; i < 20; i++) {
+    await getStockLevel(999_999);
+  }
+  expect(pool.totalCount - pool.idleCount).toBe(before);
+});
`;

const poolLeak: Incident = {
  id: "inc_pool_leak",
  title: "p95 latency and 500s on GET /api/products/:id",
  service: "shopfront",
  severity: "sev2",
  status: "awaiting_approval",
  detectedAt: "2026-10-23T02:14:00Z",
  trigger: {
    metric: "http.server.duration p95",
    unit: "ms",
    threshold: 500,
    observed: 2950,
    series: series("2026-10-23T01:56:00Z", p95Values),
  },
  steps: [
    {
      id: "step_1",
      tool: "query_metrics",
      input: { service: "shopfront", metrics: ["http.server.duration", "http.server.request.rate"], window: "30m" },
      status: "completed",
      startedAt: "2026-10-23T02:14:03Z",
      durationMs: 412,
      summary: "p95 up 25x on /api/products/:id; request rate flat",
      evidenceIds: ["ev_metric_p95", "ev_metric_rps"],
    },
    {
      id: "step_2",
      tool: "query_logs",
      input: { service: "shopfront", level: "error", window: "30m", groupBy: "message" },
      status: "completed",
      startedAt: "2026-10-23T02:14:04Z",
      durationMs: 588,
      summary: "412 connection timeouts; 418 'stock row missing' info logs",
      evidenceIds: ["ev_log_timeout", "ev_log_stock_miss"],
    },
    {
      id: "step_3",
      tool: "query_traces",
      input: { service: "shopfront", route: "GET /api/products/[id]", status: "error", limit: 5 },
      status: "completed",
      startedAt: "2026-10-23T02:14:04Z",
      durationMs: 731,
      summary: "Failing spans wait ~3000 ms for a pool connection, then error",
      evidenceIds: ["ev_span_slow"],
    },
    {
      id: "step_4",
      tool: "query_metrics",
      input: { service: "shopfront", metrics: ["db.client.connection.count"], window: "30m" },
      status: "completed",
      startedAt: "2026-10-23T02:14:06Z",
      durationMs: 305,
      summary: "Pool pinned at 10/10 in use since 02:09",
      evidenceIds: ["ev_metric_pool"],
    },
    {
      id: "step_5",
      tool: "db_diagnostics",
      input: { check: "pg_stat_activity", application: "shopfront" },
      status: "completed",
      startedAt: "2026-10-23T02:14:07Z",
      durationMs: 96,
      summary: "10 connections idle for minutes; no blocking locks",
      evidenceIds: ["ev_db_activity", "ev_db_locks"],
    },
    {
      id: "step_6",
      tool: "db_diagnostics",
      input: { check: "pg_stat_statements", top: 5 },
      status: "completed",
      startedAt: "2026-10-23T02:14:07Z",
      durationMs: 88,
      summary: "Query latency normal (mean 0.4 ms)",
      evidenceIds: ["ev_db_statements"],
    },
    {
      id: "step_7",
      tool: "deploy_history",
      input: { service: "shopfront", since: "2026-10-22T00:00:00Z" },
      status: "completed",
      startedAt: "2026-10-23T02:14:09Z",
      durationMs: 140,
      summary: "Deploy of a1b9c4e at 01:58; FF_STOCK_DIRECT_QUERY turned on at 02:00",
      evidenceIds: ["ev_commit_stock", "ev_commit_flag"],
    },
    {
      id: "step_8",
      tool: "read_source",
      input: { file: "src/lib/stock.ts", startLine: 6, endLine: 19 },
      status: "completed",
      startedAt: "2026-10-23T02:14:10Z",
      durationMs: 31,
      summary: "Early return on missing row skips client.release()",
      evidenceIds: ["ev_source_stock"],
    },
  ],
  evidence: [
    {
      id: "ev_metric_p95",
      kind: "metric",
      tool: "query_metrics",
      summary: "p95 latency 118 ms -> 2950 ms on GET /api/products/:id",
      metric: "http.server.duration p95",
      unit: "ms",
      baseline: 118,
      observed: 2950,
      series: series("2026-10-23T01:56:00Z", p95Values),
    },
    {
      id: "ev_metric_rps",
      kind: "metric",
      tool: "query_metrics",
      summary: "Request rate flat at ~14 req/s (no traffic spike)",
      metric: "http.server.request.rate",
      unit: "req/s",
      baseline: 14,
      observed: 14.6,
      series: series(
        "2026-10-23T02:02:00Z",
        [14, 13.8, 14.2, 14.1, 13.9, 14.4, 14, 14.3, 14.5, 14.2, 14.6, 14.1, 14.4, 14.6, 14.3, 14.2, 14.5, 14.6],
      ),
    },
    {
      id: "ev_metric_pool",
      kind: "metric",
      tool: "query_metrics",
      summary: "Postgres pool in-use connections climb to the max of 10 and stay there",
      metric: "db.client.connection.count{state=used}",
      unit: "connections",
      baseline: 1,
      observed: 10,
      series: series("2026-10-23T02:02:00Z", [1, 1, 2, 1, 2, 3, 4, 6, 7, 9, 10, 10, 10, 10, 10, 10, 10, 10]),
    },
    {
      id: "ev_log_timeout",
      kind: "log",
      tool: "query_logs",
      summary: "412x 'timeout exceeded when trying to connect' since 02:09",
      observedAt: "2026-10-23T02:13:41Z",
      service: "shopfront",
      level: "error",
      message: "Error: timeout exceeded when trying to connect",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      count: 412,
    },
    {
      id: "ev_log_stock_miss",
      kind: "log",
      tool: "query_logs",
      summary: "418x 'stock row missing, returning default' since 01:58",
      observedAt: "2026-10-23T02:13:39Z",
      service: "shopfront",
      level: "info",
      message: 'stock row missing, returning default {"product.id":231}',
      count: 418,
    },
    {
      id: "ev_span_slow",
      kind: "span",
      tool: "query_traces",
      summary: "GET /api/products/[id] took 3004 ms, 3000 ms waiting for pool.connect",
      observedAt: "2026-10-23T02:13:41Z",
      service: "shopfront",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      name: "GET /api/products/[id]",
      durationMs: 3004,
      status: "error",
      attributes: {
        "http.route": "/api/products/[id]",
        "http.response.status_code": 500,
        "db.client.connection.wait_time_ms": 3000,
        "db.system.name": "postgresql",
        "error.type": "Error",
      },
    },
    {
      id: "ev_db_activity",
      kind: "db",
      tool: "db_diagnostics",
      summary: "10 shopfront connections idle, oldest state change 5 min ago",
      query:
        "SELECT pid, state, now() - state_change AS idle_for, left(query, 60) AS last_query FROM pg_stat_activity WHERE application_name = 'shopfront'",
      rows: [
        { pid: 48211, state: "idle", idle_for: "00:05:12", last_query: "SELECT on_hand FROM stock_levels WHERE product_id = $1" },
        { pid: 48214, state: "idle", idle_for: "00:05:02", last_query: "SELECT on_hand FROM stock_levels WHERE product_id = $1" },
        { pid: 48219, state: "idle", idle_for: "00:04:47", last_query: "SELECT on_hand FROM stock_levels WHERE product_id = $1" },
        { pid: 48230, state: "idle", idle_for: "00:04:31", last_query: "SELECT on_hand FROM stock_levels WHERE product_id = $1" },
        { pid: 48236, state: "idle", idle_for: "00:04:20", last_query: "SELECT on_hand FROM stock_levels WHERE product_id = $1" },
      ],
    },
    {
      id: "ev_db_locks",
      kind: "db",
      tool: "db_diagnostics",
      summary: "No blocked or blocking sessions",
      query: "SELECT count(*) AS blocked FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0",
      rows: [{ blocked: 0 }],
    },
    {
      id: "ev_db_statements",
      kind: "db",
      tool: "db_diagnostics",
      summary: "Top statements by total time all run under 1 ms on average",
      query: "SELECT left(query, 50) AS query, calls, round(mean_exec_time::numeric, 2) AS mean_ms FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 3",
      rows: [
        { query: "SELECT on_hand FROM stock_levels WHERE product_id = $1", calls: 9120, mean_ms: 0.41 },
        { query: 'select "id", "name", "price_cents", "created_at" from', calls: 9204, mean_ms: 0.38 },
        { query: "SELECT 1", calls: 1810, mean_ms: 0.02 },
      ],
    },
    {
      id: "ev_commit_stock",
      kind: "commit",
      tool: "deploy_history",
      summary: "a1b9c4e 'feat: show stock level on product page', deployed 01:58",
      observedAt: "2026-10-23T01:58:00Z",
      sha: "a1b9c4e",
      author: "sebastian",
      message: "feat: show stock level on product page",
      files: ["src/lib/stock.ts", "src/app/api/products/[id]/route.ts"],
    },
    {
      id: "ev_commit_flag",
      kind: "commit",
      tool: "deploy_history",
      summary: "Config change on shopfront at 02:00: 'ops: FF_STOCK_DIRECT_QUERY turned on'",
      observedAt: "2026-10-23T02:00:00Z",
      sha: "config:FF_STOCK_DIRECT_QUERY",
      author: "unknown",
      message: "ops: FF_STOCK_DIRECT_QUERY turned on",
      files: [],
    },
    {
      id: "ev_source_stock",
      kind: "source",
      tool: "read_source",
      summary: "getStockLevel returns before client.release() when the row is missing",
      file: "src/lib/stock.ts",
      startLine: 6,
      code: `export async function getStockLevel(productId: number): Promise<number> {
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
}`,
    },
  ],
  report: {
    summary:
      "Since the 01:58 deploy, product pages leak a database connection whenever a product has no stock row. The pool ran out at 02:09, so requests now time out.",
    servicesQueried: ["shopfront", "postgres"],
    hypotheses: [
      {
        id: "h_pool_leak",
        title: "Connection leak in getStockLevel exhausts the pg pool",
        confidence: 0.86,
        status: "leading",
        causalChain: {
          symptom: {
            text: "p95 latency on GET /api/products/:id rose from 118 ms to ~3000 ms and requests fail with connection timeouts.",
            evidenceIds: ["ev_metric_p95", "ev_log_timeout"],
          },
          propagation: {
            text: "All 10 pool connections are checked out but idle in Postgres, so new requests wait the full 3 s connectionTimeout and return 500.",
            evidenceIds: ["ev_metric_pool", "ev_db_activity", "ev_span_slow"],
          },
          rootCause: {
            text: "Commit a1b9c4e added getStockLevel, which returns early on a missing stock row without calling client.release(); turning on FF_STOCK_DIRECT_QUERY at 02:00 put it on the request path. Each miss leaks one connection.",
            evidenceIds: ["ev_source_stock", "ev_commit_stock", "ev_commit_flag", "ev_log_stock_miss"],
          },
        },
      },
      {
        id: "h_slow_query",
        title: "Slow product query holds connections",
        confidence: 0.06,
        status: "rejected",
        causalChain: {
          symptom: { text: "Latency rose on the product route.", evidenceIds: ["ev_metric_p95"] },
          propagation: { text: "Long-running queries would keep connections busy.", evidenceIds: ["ev_metric_pool"] },
          rootCause: { text: "A missing index on stock.product_id.", evidenceIds: ["ev_db_statements"] },
        },
        rejectedBecause: {
          text: "Every top statement averages under 1 ms, and the held connections are idle, not active.",
          evidenceIds: ["ev_db_statements", "ev_db_activity"],
        },
      },
      {
        id: "h_traffic",
        title: "Traffic spike exceeds pool capacity",
        confidence: 0.05,
        status: "rejected",
        causalChain: {
          symptom: { text: "Pool saturated.", evidenceIds: ["ev_metric_pool"] },
          propagation: { text: "More concurrent requests than connections.", evidenceIds: ["ev_metric_rps"] },
          rootCause: { text: "Organic or bot traffic surge.", evidenceIds: ["ev_metric_rps"] },
        },
        rejectedBecause: {
          text: "Request rate stayed flat at ~14 req/s through the incident.",
          evidenceIds: ["ev_metric_rps"],
        },
      },
      {
        id: "h_lock_contention",
        title: "Lock contention blocks queries",
        confidence: 0.03,
        status: "rejected",
        causalChain: {
          symptom: { text: "Requests stall waiting on the database.", evidenceIds: ["ev_span_slow"] },
          propagation: { text: "Blocked sessions keep connections checked out.", evidenceIds: ["ev_metric_pool"] },
          rootCause: { text: "A migration or long transaction holding row locks.", evidenceIds: ["ev_db_locks"] },
        },
        rejectedBecause: {
          text: "pg_blocking_pids reports zero blocked sessions.",
          evidenceIds: ["ev_db_locks"],
        },
      },
    ],
    verdict: { kind: "root_cause", hypothesisId: "h_pool_leak" },
  },
  fix: {
    summary: "Release the pooled client in a finally block so every return path gives the connection back, and add a regression test for the missing-row path.",
    patch: poolLeakPatch,
    files: ["src/lib/stock.ts", "src/lib/stock.test.ts"],
    regressionTest: { file: "src/lib/stock.test.ts", name: "releases the client when the stock row is missing" },
    risk: "low",
    touchesData: false,
  },
  validation: [
    {
      label: "Original code",
      ref: "original",
      command: "pnpm vitest run src/lib/stock.test.ts",
      exitCode: 1,
      durationMs: 1840,
      tests: [
        {
          name: "releases the client when the stock row is missing",
          status: "failed",
          durationMs: 1622,
          error: "AssertionError: expected 10 to be 0",
        },
      ],
      repro: { request: "GET /api/products/231", status: 500, latencyMs: 3004 },
      output:
        " FAIL  src/lib/stock.test.ts > releases the client when the stock row is missing\nAssertionError: expected 10 to be 0\n\n Test Files  1 failed (1)\n      Tests  1 failed (1)\n\nexit code 1",
    },
    {
      label: "Patched code",
      ref: "patched",
      command: "pnpm vitest run src/lib/stock.test.ts",
      exitCode: 0,
      durationMs: 702,
      tests: [
        {
          name: "releases the client when the stock row is missing",
          status: "passed",
          durationMs: 418,
        },
      ],
      repro: { request: "GET /api/products/231", status: 200, latencyMs: 42 },
      output:
        " ✓ src/lib/stock.test.ts > releases the client when the stock row is missing 418ms\n\n Test Files  1 passed (1)\n      Tests  1 passed (1)\n\nexit code 0",
    },
  ],
  approval: {
    state: "pending",
    requestedAt: "2026-10-23T02:16:30Z",
  },
};

// What proposeMitigation makes of the report once it lands, as a run stores it.
poolLeak.mitigation = proposeMitigation(poolLeak.report!, poolLeak.evidence, poolLeak.service, "2026-10-23T02:14:12Z");

const controlRun: Incident = {
  id: "inc_control",
  title: "Control run: product page latency check",
  service: "shopfront",
  severity: "sev4",
  status: "healthy",
  detectedAt: "2026-10-23T09:30:00Z",
  trigger: {
    metric: "http.server.duration p95",
    unit: "ms",
    threshold: 500,
    observed: 124,
    series: series(
      "2026-10-23T09:18:00Z",
      [119, 121, 117, 123, 120, 118, 122, 125, 119, 121, 124, 120, 118, 123, 121, 122, 120, 124],
    ),
  },
  steps: [
    {
      id: "step_1",
      tool: "query_metrics",
      input: { service: "shopfront", metrics: ["http.server.duration", "db.client.connection.count"], window: "30m" },
      status: "completed",
      startedAt: "2026-10-23T09:30:02Z",
      durationMs: 388,
      summary: "Latency and pool usage within baseline",
      evidenceIds: ["ev_metric_p95_ok", "ev_metric_pool_ok"],
    },
    {
      id: "step_2",
      tool: "query_logs",
      input: { service: "shopfront", level: "error", window: "30m" },
      status: "completed",
      startedAt: "2026-10-23T09:30:03Z",
      durationMs: 402,
      summary: "No error logs in the window",
      evidenceIds: ["ev_log_none"],
    },
  ],
  evidence: [
    {
      id: "ev_metric_p95_ok",
      kind: "metric",
      tool: "query_metrics",
      summary: "p95 latency steady at ~120 ms",
      metric: "http.server.duration p95",
      unit: "ms",
      baseline: 120,
      observed: 124,
      series: series(
        "2026-10-23T09:18:00Z",
        [119, 121, 117, 123, 120, 118, 122, 125, 119, 121, 124, 120, 118, 123, 121, 122, 120, 124],
      ),
    },
    {
      id: "ev_metric_pool_ok",
      kind: "metric",
      tool: "query_metrics",
      summary: "Pool in-use connections between 1 and 3 of 10",
      metric: "db.client.connection.count{state=used}",
      unit: "connections",
      baseline: 2,
      observed: 2,
      series: series("2026-10-23T09:18:00Z", [1, 2, 2, 1, 3, 2, 2, 1, 2, 3, 2, 2, 1, 2, 2, 3, 2, 2]),
    },
    {
      id: "ev_log_none",
      kind: "log",
      tool: "query_logs",
      summary: "0 error-level log records in the last 30 min",
      service: "shopfront",
      level: "info",
      message: "query returned 0 records for level >= error",
      count: 1,
    },
  ],
  report: {
    summary: "Product pages are fast and error-free, and the database is healthy. Nothing needs fixing.",
    servicesQueried: ["shopfront", "postgres"],
    hypotheses: [],
    verdict: {
      kind: "healthy",
      rationale: {
        text: "Latency, pool usage and error logs are all at baseline. No action needed.",
        evidenceIds: ["ev_metric_p95_ok", "ev_metric_pool_ok", "ev_log_none"],
      },
    },
  },
};

// A fix with a data half, on the second fault (FF_LIST_PRICES): the code
// stops leaving new arrivals out of the price list, and a migration
// backfills the rows already missing, registered in Drizzle's journal by
// Triage. The sandbox proves the code; the migration only ships in the PR,
// so approving it needs the reviewer to say they read it (see
// fix/data-change.ts and fix/migration.ts).
const priceGapPatch = `--- a/src/lib/prices.ts
+++ b/src/lib/prices.ts
@@ -1,19 +1,18 @@
 import { eq, sql } from "drizzle-orm";
 import { db } from "@/db/client";
-import { productPrices, products, stockLevels, type Product } from "@/db/schema";
+import { productPrices, products, type Product } from "@/db/schema";
 import { isEnabled } from "@/lib/flags";
 
 // Copies catalog prices into the price list, adding new products and
-// updating changed prices. Only products we sell get a list price, so it
-// takes the products inventory carries.
+// updating changed prices. Every catalog product gets a list price, in
+// stock or not: a new arrival has no stock row until its first delivery.
 export async function syncListPrices() {
   return db
     .insert(productPrices)
     .select(
       db
         .select({ productId: products.id, amountCents: products.priceCents, updatedAt: sql\`now()\`.as("updated_at") })
-        .from(products)
-        .innerJoin(stockLevels, eq(stockLevels.productId, products.id)),
+        .from(products),
     )
     .onConflictDoUpdate({
       target: productPrices.productId,
@@ -22,19 +21,20 @@ export async function syncListPrices() {
     .returning({ productId: productPrices.productId });
 }
 
-// One product's price from the price list.
-export async function getListPrice(productId: number): Promise<number> {
-  const [{ amountCents }] = await db
+// One product's price from the price list, if it has one.
+export async function getListPrice(productId: number): Promise<number | undefined> {
+  const [row] = await db
     .select({ amountCents: productPrices.amountCents })
     .from(productPrices)
     .where(eq(productPrices.productId, productId))
     .limit(1);
-  return amountCents;
+  return row?.amountCents;
 }
 
 // What a product sells for. FF_LIST_PRICES moves the product page, the
 // product API and the cart over to the price list; listings keep the
 // catalog price until it's rolled out.
 export async function priceOf(product: Pick<Product, "id" | "priceCents">): Promise<number> {
-  return isEnabled("FF_LIST_PRICES") ? getListPrice(product.id) : product.priceCents;
+  if (!isEnabled("FF_LIST_PRICES")) return product.priceCents;
+  return (await getListPrice(product.id)) ?? product.priceCents;
 }
--- /dev/null
+++ b/drizzle/0005_backfill_product_prices.sql
@@ -0,0 +1,5 @@
+-- New arrivals were left out of the price list: give every product without
+-- a list price its catalog price. Safe to run again.
+INSERT INTO "product_prices" ("product_id", "amount_cents")
+SELECT "id", "price_cents" FROM "products"
+ON CONFLICT ("product_id") DO NOTHING;
--- a/drizzle/meta/_journal.json
+++ b/drizzle/meta/_journal.json
@@ -36,6 +36,13 @@
       "when": 1793401492714,
       "tag": "0004_product_prices",
       "breakpoints": true
+    },
+    {
+      "idx": 5,
+      "version": "7",
+      "when": 1793401492715,
+      "tag": "0005_backfill_product_prices",
+      "breakpoints": true
     }
   ]
 }
\\ No newline at end of file
--- /dev/null
+++ b/src/lib/prices.test.ts
@@ -0,0 +1,10 @@
+import { describe, expect, it } from "vitest";
+import { setFlag } from "@/lib/flags";
+import { priceOf } from "./prices";
+
+describe("priceOf", () => {
+  it("falls back to the catalog price when a product has no list price", async () => {
+    setFlag("FF_LIST_PRICES", true);
+    await expect(priceOf({ id: 999_999, priceCents: 1250 })).resolves.toBe(1250);
+  });
+});
`;

const priceGapErrors = [0, 0, 0.1, 0, 0, 0, 0.1, 0, 4.2, 5.1, 4.8, 5.3, 5.0, 4.9, 5.2, 5.1, 4.7, 5.0];
const priceGapError = "TypeError: Cannot destructure property 'amountCents' of '(intermediate value)' as it is undefined.";

const priceGap: Incident = {
  id: "inc_price_gap",
  title: "500s on product pages for new arrivals",
  service: "shopfront",
  severity: "sev3",
  status: "awaiting_approval",
  detectedAt: "2026-10-24T15:20:00Z",
  trigger: {
    metric: "http.server.error.rate",
    unit: "%",
    threshold: 2,
    observed: 5.0,
    series: series("2026-10-24T15:03:00Z", priceGapErrors),
  },
  steps: [
    {
      id: "step_1",
      tool: "query_logs",
      input: { service: "shopfront", level: "error", window: "30m", groupBy: "message" },
      status: "completed",
      startedAt: "2026-10-24T15:20:03Z",
      durationMs: 512,
      summary: "96 TypeErrors in getListPrice since 15:11, all for the three new arrivals",
      evidenceIds: ["ev_metric_errors", "ev_log_price"],
    },
    {
      id: "step_2",
      tool: "deploy_history",
      input: { service: "shopfront", since: "2026-10-24T00:00:00Z" },
      status: "completed",
      startedAt: "2026-10-24T15:20:05Z",
      durationMs: 133,
      summary: "FF_LIST_PRICES turned on at 15:11",
      evidenceIds: ["ev_commit_prices_flag"],
    },
    {
      id: "step_3",
      tool: "db_diagnostics",
      input: { check: "query", table: "product_prices" },
      status: "completed",
      startedAt: "2026-10-24T15:20:06Z",
      durationMs: 41,
      summary: "3 products have no product_prices row; none of them has a stock row",
      evidenceIds: ["ev_db_missing_prices"],
    },
    {
      id: "step_4",
      tool: "read_source",
      input: { file: "src/lib/prices.ts", startLine: 9, endLine: 32 },
      status: "completed",
      startedAt: "2026-10-24T15:20:07Z",
      durationMs: 28,
      summary: "syncListPrices joins stock_levels; getListPrice assumes a row",
      evidenceIds: ["ev_source_prices"],
    },
  ],
  evidence: [
    {
      id: "ev_metric_errors",
      kind: "metric",
      tool: "query_metrics",
      summary: "5xx rate 0% -> 5% on GET /products/[slug] from 15:11",
      metric: "http.server.error.rate",
      unit: "%",
      baseline: 0,
      observed: 5.0,
      series: series("2026-10-24T15:03:00Z", priceGapErrors),
    },
    {
      id: "ev_log_price",
      kind: "log",
      tool: "query_logs",
      summary: "96x \"Cannot destructure property 'amountCents'\" in getListPrice since 15:11",
      observedAt: "2026-10-24T15:19:48Z",
      service: "shopfront",
      level: "error",
      message: `${priceGapError} at getListPrice`,
      count: 96,
    },
    {
      id: "ev_commit_prices_flag",
      kind: "commit",
      tool: "deploy_history",
      summary: "Config change on shopfront at 15:11: 'ops: FF_LIST_PRICES turned on'",
      observedAt: "2026-10-24T15:11:00Z",
      sha: "config:FF_LIST_PRICES",
      author: "unknown",
      message: "ops: FF_LIST_PRICES turned on",
      files: [],
    },
    {
      id: "ev_db_missing_prices",
      kind: "db",
      tool: "db_diagnostics",
      summary: "3 products without a list price, all new arrivals with no stock row",
      query:
        "SELECT p.id, p.slug, s.product_id AS stock_row FROM products p LEFT JOIN product_prices pp ON pp.product_id = p.id LEFT JOIN stock_levels s ON s.product_id = p.id WHERE pp.product_id IS NULL",
      rows: [
        { id: 241, slug: "linen-apron", stock_row: null },
        { id: 242, slug: "oak-serving-board", stock_row: null },
        { id: 243, slug: "stoneware-jug", stock_row: null },
      ],
    },
    {
      id: "ev_source_prices",
      kind: "source",
      tool: "read_source",
      summary: "getListPrice destructures the first row without checking there is one",
      file: "src/lib/prices.ts",
      startLine: 26,
      code: `export async function getListPrice(productId: number): Promise<number> {
  const [{ amountCents }] = await db
    .select({ amountCents: productPrices.amountCents })
    .from(productPrices)
    .where(eq(productPrices.productId, productId))
    .limit(1);
  return amountCents;
}`,
    },
  ],
  report: {
    summary:
      "Since FF_LIST_PRICES went on at 15:11, the three new arrivals' pages fail: the price sync skips products without a stock row, so they have no list price, and getListPrice assumes one.",
    servicesQueried: ["shopfront", "postgres"],
    hypotheses: [
      {
        id: "h_price_gap",
        title: "New arrivals missing from product_prices crash getListPrice",
        confidence: 0.9,
        status: "leading",
        causalChain: {
          symptom: {
            text: "About 5% of product page requests return 500 since 15:11.",
            evidenceIds: ["ev_metric_errors"],
          },
          propagation: {
            text: "getListPrice throws for products with no product_prices row, and the page has no fallback.",
            evidenceIds: ["ev_log_price", "ev_source_prices", "ev_db_missing_prices"],
          },
          rootCause: {
            text: "syncListPrices inner-joins stock_levels, so products with no stock row yet never got a list price; turning on FF_LIST_PRICES put getListPrice on the request path.",
            evidenceIds: ["ev_commit_prices_flag", "ev_db_missing_prices", "ev_source_prices"],
          },
        },
      },
    ],
    verdict: { kind: "root_cause", hypothesisId: "h_price_gap" },
  },
  fix: {
    summary:
      "Sync every catalog product into the price list, not only those with a stock row, fall back to the catalog price when a list price is missing, and backfill the rows the sync skipped.",
    patch: priceGapPatch,
    files: [
      "src/lib/prices.ts",
      "drizzle/0005_backfill_product_prices.sql",
      "drizzle/meta/_journal.json",
      "src/lib/prices.test.ts",
    ],
    regressionTest: {
      file: "src/lib/prices.test.ts",
      name: "falls back to the catalog price when a product has no list price",
    },
    risk: "medium",
    touchesData: true,
  },
  validation: [
    {
      label: "Original code",
      ref: "original",
      command: "pnpm vitest run src/lib/prices.test.ts",
      exitCode: 1,
      durationMs: 1510,
      tests: [
        {
          name: "falls back to the catalog price when a product has no list price",
          status: "failed",
          durationMs: 38,
          error: priceGapError,
        },
      ],
      output: ` FAIL  src/lib/prices.test.ts > priceOf > falls back to the catalog price when a product has no list price\n${priceGapError}\n\n Test Files  1 failed (1)\n      Tests  1 failed (1)\n\nexit code 1`,
    },
    {
      label: "Patched code",
      ref: "patched",
      command: "pnpm vitest run src/lib/prices.test.ts",
      exitCode: 0,
      durationMs: 1288,
      tests: [
        { name: "falls back to the catalog price when a product has no list price", status: "passed", durationMs: 21 },
      ],
      output:
        " ✓ src/lib/prices.test.ts > priceOf > falls back to the catalog price when a product has no list price 21ms\n\n Test Files  1 passed (1)\n      Tests  1 passed (1)\n\nexit code 0",
    },
    {
      label: "Patched code: typecheck",
      ref: "patched",
      command: "pnpm tsc --noEmit",
      exitCode: 0,
      durationMs: 6120,
      tests: [],
      output: "No type errors.\n\nexit code 0",
    },
  ],
  approval: {
    state: "pending",
    requestedAt: "2026-10-24T15:23:10Z",
  },
};
priceGap.mitigation = proposeMitigation(priceGap.report!, priceGap.evidence, priceGap.service, "2026-10-24T15:21:30Z");

// The third fault (FF_LIVE_RATINGS), cut down from a real watch-opened run
// on Nov 2 (Muse Spark 1.3, high effort): its steps, evidence, patch and
// sandbox results, trimmed to the ones the diagnosis rests on. One finding
// is left out: the run's slow-query list was topped by Triage's own copy of
// the reviews table into a fix sandbox, which it read as the store's.
const liveRatingsPatch = `--- a/src/lib/ratings.ts
+++ b/src/lib/ratings.ts
@@ -1,4 +1,4 @@
-import { eq, inArray } from "drizzle-orm";
+import { inArray, sql } from "drizzle-orm";
 import { db } from "@/db/client";
 import { products, reviews } from "@/db/schema";
 import { isEnabled } from "@/lib/flags";
@@ -22,12 +22,20 @@ export async function getListingRatings(productIds: number[]): Promise<Map<numbe
     return ratings;
   }

-  for (const id of productIds) {
-    const rows = await db.select({ rating: reviews.rating }).from(reviews).where(eq(reviews.productId, id));
-    const total = rows.reduce((sum, r) => sum + r.rating, 0);
-    ratings.set(id, {
-      ratingTenths: rows.length ? Math.round((total / rows.length) * 10) : 0,
-      reviewCount: rows.length,
+  const rows = await db
+    .select({
+      productId: reviews.productId,
+      reviewCount: sql<number>\`count(*)::int\`,
+      avgRating: sql<number | null>\`avg(\${reviews.rating})::float\`,
+    })
+    .from(reviews)
+    .where(inArray(reviews.productId, productIds))
+    .groupBy(reviews.productId);
+  for (const id of productIds) ratings.set(id, { ratingTenths: 0, reviewCount: 0 });
+  for (const row of rows) {
+    ratings.set(row.productId, {
+      ratingTenths: row.avgRating == null ? 0 : Math.round(row.avgRating * 10),
+      reviewCount: Number(row.reviewCount),
     });
   }
   return ratings;
--- /dev/null
+++ b/src/lib/ratings.test.ts
@@ -0,0 +1,47 @@
+import { describe, it, expect, afterAll } from "vitest";
+import { inArray } from "drizzle-orm";
+import { db, pool, queriesIssued, rowsFetched } from "@/db/client";
+import { products, reviews } from "@/db/schema";
+import { setFlag } from "@/lib/flags";
+import { getListingRatings } from "@/lib/ratings";
+
+describe("getListingRatings", () => {
+  afterAll(async () => {
+    await pool.end();
+  });
+
+  it("averages live ratings with a single aggregated query", async () => {
+    setFlag("FF_LIVE_RATINGS", true);
+    const suffix = \`\${Date.now()}-\${Math.floor(Math.random() * 1000000)}\`;
+    const names = [0, 1, 2].map((i) => \`test-rating-\${suffix}-\${i}\`);
+    let ids: number[] = [];
+    try {
+      const inserted = await db
+        .insert(products)
+        .values(names.map((name) => ({ name, priceCents: 100 })))
+        .returning({ id: products.id });
+      ids = inserted.map((r) => r.id);
+      await db.insert(reviews).values([
+        { productId: ids[0], rating: 5 },
+        { productId: ids[0], rating: 5 },
+        { productId: ids[0], rating: 4 },
+        { productId: ids[1], rating: 3 },
+      ]);
+      const queriesBefore = queriesIssued();
+      const rowsBefore = rowsFetched();
+      const ratings = await getListingRatings(ids);
+      const queriesAfter = queriesIssued();
+      const rowsAfter = rowsFetched();
+      expect(ratings.get(ids[0])).toEqual({ ratingTenths: 47, reviewCount: 3 });
+      expect(ratings.get(ids[1])).toEqual({ ratingTenths: 30, reviewCount: 1 });
+      expect(ratings.get(ids[2])).toEqual({ ratingTenths: 0, reviewCount: 0 });
+      expect(queriesAfter - queriesBefore).toBe(1);
+      expect(rowsAfter - rowsBefore).toBeLessThanOrEqual(ids.length);
+    } finally {
+      setFlag("FF_LIVE_RATINGS", false);
+      if (ids.length > 0) {
+        await db.delete(products).where(inArray(products.id, ids));
+      }
+    }
+  });
+});
`;

// p95 of GET / from 23:57, a minute apart, as the run measured it: the
// rollout was already slowing the page when the window opens.
const liveRatingsP95 = [
  3128.8, 2123.2, 963.8, 739.5, 1842.5, 1887.3, 1820.5, 2396.5, 1275.1, 2245.7, 1929.1, 1719.6, 1700.1, 2035.1, 1556.4, 1571.3,
  1123.4, 1799.0, 978.9, 1454.9, 1214.6, 1409.4, 890.9, 1529.1, 2116.8, 1898.7, 1424.0, 974.0, 1116.5, 2129.9,
];
const liveRatingsTest = "averages live ratings with a single aggregated query";

const liveRatings: Incident = {
  id: "inc_live_ratings",
  title: "More than 3 requests slower than 1500 ms on GET /",
  service: "shopfront",
  severity: "sev3",
  status: "awaiting_approval",
  detectedAt: "2026-11-02T00:26:33Z",
  openedBy: "watch",
  trigger: {
    metric: "http.server.request.duration.p95{route=/}",
    unit: "ms",
    threshold: 1500,
    observed: 2129.9,
    series: series("2026-11-01T23:57:00Z", liveRatingsP95),
    rule: { id: "page-latency", name: "Page latency", description: "more than 3 requests slower than 1500 ms on each page" },
    route: "/",
  },
  steps: [
    {
      id: "step_1",
      tool: "query_traces",
      input: { service: "shopfront", route: "/", minDurationMs: 1500, limit: 10, windowMinutes: 30 },
      status: "completed",
      startedAt: "2026-11-02T00:26:37Z",
      durationMs: 81,
      summary: "10 home page requests over 1.5 s in 30 minutes, the slowest 3.1 s",
      evidenceIds: ["ev_span_home"],
    },
    {
      id: "step_2",
      tool: "query_metrics",
      input: { metrics: ["http.server.request.duration.p95{route=/}"], windowMinutes: 30 },
      status: "completed",
      startedAt: "2026-11-02T00:26:39Z",
      durationMs: 15,
      summary: "Home page p95 between 0.7 and 3.1 s for the last half hour",
      evidenceIds: ["ev_metric_p95"],
    },
    {
      id: "step_3",
      tool: "query_logs",
      input: { service: "shopfront", minLevel: "warn", windowMinutes: 30 },
      status: "completed",
      startedAt: "2026-11-02T00:26:39Z",
      durationMs: 12,
      summary: "49 slow-request warnings on GET /, no errors",
      evidenceIds: ["ev_log_slow"],
    },
    {
      id: "step_4",
      tool: "query_metrics",
      input: { metrics: ["http.server.request.rate"], windowMinutes: 30 },
      status: "completed",
      startedAt: "2026-11-02T00:26:43Z",
      durationMs: 73,
      summary: "About 1 request a second, no spike",
      evidenceIds: ["ev_metric_rate"],
    },
    {
      id: "step_5",
      tool: "query_metrics",
      input: { metrics: ["db.client.connection.count{state=used}"], windowMinutes: 30 },
      status: "completed",
      startedAt: "2026-11-02T00:26:43Z",
      durationMs: 69,
      summary: "1 of 10 database connections in use, at most 2",
      evidenceIds: ["ev_metric_pool"],
    },
    {
      id: "step_6",
      tool: "db_diagnostics",
      input: { check: "locks" },
      status: "completed",
      startedAt: "2026-11-02T00:26:43Z",
      durationMs: 26,
      summary: "No blocked queries",
      evidenceIds: ["ev_db_locks"],
    },
    {
      id: "step_7",
      tool: "git_log",
      input: { path: "src/lib/ratings.ts", limit: 5 },
      status: "completed",
      startedAt: "2026-11-02T00:26:47Z",
      durationMs: 40,
      summary: "e5ac370 added live ratings behind FF_LIVE_RATINGS",
      evidenceIds: ["ev_commit_ratings"],
    },
    {
      id: "step_8",
      tool: "read_source",
      input: { path: "src/lib/ratings.ts" },
      status: "completed",
      startedAt: "2026-11-02T00:26:48Z",
      durationMs: 26,
      summary: "Live ratings load every review of each listed product, one query per product",
      evidenceIds: ["ev_source_ratings"],
    },
    {
      id: "step_9",
      tool: "read_source",
      input: { path: "src/db/seed.ts" },
      status: "completed",
      startedAt: "2026-11-02T00:26:53Z",
      durationMs: 53,
      summary: "The store holds 50,000 reviews per product",
      evidenceIds: ["ev_source_seed"],
    },
  ],
  evidence: [
    {
      id: "ev_span_home",
      kind: "span",
      tool: "query_traces",
      summary: "shopfront GET / 3129 ms ok at 23:57",
      observedAt: "2026-11-01T23:57:31Z",
      service: "shopfront",
      traceId: "66772b008c4debaedd518a4fb45daba6",
      name: "GET /",
      durationMs: 3128.8,
      status: "ok",
      attributes: { "http.response.status_code": 200, "url.path": "/", "db.client.connection.wait_time_ms": 55.8, "db.queries": 4 },
    },
    {
      id: "ev_metric_p95",
      kind: "metric",
      tool: "query_metrics",
      summary: "http.server.request.duration.p95{route=/}: 1842.5 -> 2129.9 ms (peak 3128.8 at 23:57)",
      metric: "http.server.request.duration.p95{route=/}",
      unit: "ms",
      baseline: 1842.5,
      observed: 2129.9,
      series: series("2026-11-01T23:57:00Z", liveRatingsP95),
    },
    {
      id: "ev_log_slow",
      kind: "log",
      tool: "query_logs",
      summary: "49x warn 'slow request' on GET / (23:56 to 00:26)",
      observedAt: "2026-11-02T00:26:17Z",
      service: "shopfront",
      level: "warn",
      message:
        'slow request {"http.request.method":"GET","http.route":"/","http.response.status_code":<n>,"url.path":"/","duration_ms":<n>}',
      count: 49,
      traceId: "1888b6497c361c114f2e2dd872ab2340",
    },
    {
      id: "ev_metric_rate",
      kind: "metric",
      tool: "query_metrics",
      summary: "http.server.request.rate: 0.98 -> 1.21 req/s (peak 1.98 at 00:04)",
      metric: "http.server.request.rate",
      unit: "req/s",
      baseline: 0.98,
      observed: 1.21,
      series: series(
        "2026-11-01T23:57:00Z",
        [
          1.03, 1.3, 0.98, 0.85, 0.9, 1.17, 0.98, 1.98, 0.85, 0.82, 1.33, 0.6, 0.98, 1.37, 1, 1.32, 0.97, 1.2, 0.72, 1.32, 1.03, 1.23,
          0.88, 1.15, 1.2, 1.05, 0.83, 1.22, 0.85, 1.21,
        ],
      ),
    },
    {
      id: "ev_metric_pool",
      kind: "metric",
      tool: "query_metrics",
      summary: "db.client.connection.count{state=used}: 1 of a 10-connection pool (peak 2)",
      metric: "db.client.connection.count{state=used}",
      unit: "connections",
      baseline: 1,
      observed: 1,
      series: series(
        "2026-11-01T23:57:00Z",
        [1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 0, 1, 2, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1],
      ),
    },
    {
      id: "ev_db_locks",
      kind: "db",
      tool: "db_diagnostics",
      summary: "locks: no rows",
      query:
        "SELECT pid, pg_blocking_pids(pid)::text AS blocked_by, left(query, 60) AS query FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0",
      rows: [],
    },
    {
      id: "ev_commit_ratings",
      kind: "commit",
      tool: "git_log",
      summary: "e5ac370 'feat(shopfront): live ratings from the reviews table, behind FF_LIVE_RATINGS' by teapot2 at 05:14",
      observedAt: "2026-11-01T05:14:19Z",
      sha: "e5ac370",
      author: "teapot2",
      message: "feat(shopfront): live ratings from the reviews table, behind FF_LIVE_RATINGS",
      files: ["src/lib/ratings.ts"],
    },
    {
      id: "ev_source_ratings",
      kind: "source",
      tool: "read_source",
      summary: "getListingRatings loads every review of each product and averages them in JavaScript",
      file: "src/lib/ratings.ts",
      startLine: 12,
      code: `export async function getListingRatings(productIds: number[]): Promise<Map<number, ListingRating>> {
  const ratings = new Map<number, ListingRating>();
  if (productIds.length === 0) return ratings;

  if (!isEnabled("FF_LIVE_RATINGS")) {
    const rows = await db
      .select({ id: products.id, ratingTenths: products.ratingTenths, reviewCount: products.reviewCount })
      .from(products)
      .where(inArray(products.id, productIds));
    for (const { id, ...rating } of rows) ratings.set(id, rating);
    return ratings;
  }

  for (const id of productIds) {
    const rows = await db.select({ rating: reviews.rating }).from(reviews).where(eq(reviews.productId, id));
    const total = rows.reduce((sum, r) => sum + r.rating, 0);
    ratings.set(id, {
      ratingTenths: rows.length ? Math.round((total / rows.length) * 10) : 0,
      reviewCount: rows.length,
    });
  }
  return ratings;
}`,
    },
    {
      id: "ev_source_seed",
      kind: "source",
      tool: "read_source",
      summary: "The seed writes 50,000 reviews for each product",
      file: "src/db/seed.ts",
      startLine: 7,
      code: `// Reviews written for each product. Stands in for a busy store's review
// history: years of orders, each one a chance of a review.
const REVIEWS_PER_PRODUCT = 50_000;`,
    },
  ],
  report: {
    summary:
      "The home page has been slow since live ratings went on: for every listed product, getListingRatings loads all 50,000 of its reviews and averages them in JavaScript, one query per product.",
    servicesQueried: ["shopfront", "postgres"],
    hypotheses: [
      {
        id: "h_live_ratings",
        title: "Live ratings load every review, one product at a time",
        confidence: 0.85,
        status: "leading",
        causalChain: {
          symptom: {
            text: "GET / p95 around 2.1 s, with 49 slow requests in half an hour and traces up to 3.1 s.",
            evidenceIds: ["ev_metric_p95", "ev_log_slow", "ev_span_home"],
          },
          propagation: {
            text: "The home page's listings call getListingRatings, which with FF_LIVE_RATINGS on runs one reviews query per product and pulls every row into the server to average.",
            evidenceIds: ["ev_source_ratings", "ev_span_home"],
          },
          rootCause: {
            text: "Commit e5ac370 added live ratings as a per-product loop over the reviews table, which holds 50,000 reviews per product.",
            evidenceIds: ["ev_commit_ratings", "ev_source_ratings", "ev_source_seed"],
          },
        },
      },
      {
        id: "h_pool",
        title: "Connection pool exhaustion",
        confidence: 0.05,
        status: "rejected",
        causalChain: {
          symptom: { text: "GET / p95 around 2.1 s.", evidenceIds: ["ev_metric_p95"] },
          propagation: {
            text: "A full pool would leave requests waiting for a connection, but at most 2 of 10 were in use.",
            evidenceIds: ["ev_metric_pool"],
          },
          rootCause: { text: "Nothing holds connections: the pool stays nearly idle.", evidenceIds: ["ev_metric_pool"] },
        },
      },
      {
        id: "h_traffic",
        title: "Traffic spike",
        confidence: 0.05,
        status: "rejected",
        causalChain: {
          symptom: { text: "GET / p95 around 2.1 s.", evidenceIds: ["ev_metric_p95"] },
          propagation: { text: "More traffic would load the server, but the rate held near 1 request a second.", evidenceIds: ["ev_metric_rate"] },
          rootCause: { text: "No surge in the window.", evidenceIds: ["ev_metric_rate"] },
        },
      },
      {
        id: "h_locks",
        title: "Lock contention",
        confidence: 0.05,
        status: "rejected",
        causalChain: {
          symptom: { text: "GET / p95 around 2.1 s.", evidenceIds: ["ev_metric_p95"] },
          propagation: { text: "Blocked queries would show in the lock check, which found none.", evidenceIds: ["ev_db_locks"] },
          rootCause: { text: "No query is waiting on another.", evidenceIds: ["ev_db_locks"] },
        },
      },
    ],
    verdict: { kind: "root_cause", hypothesisId: "h_live_ratings" },
  },
  fix: {
    summary:
      "Replace the per-product review scan with one grouped AVG/COUNT query, so listings no longer fetch every review row.",
    patch: liveRatingsPatch,
    files: ["src/lib/ratings.ts", "src/lib/ratings.test.ts"],
    regressionTest: { file: "src/lib/ratings.test.ts", name: liveRatingsTest },
    risk: "low",
    touchesData: false,
  },
  validation: [
    {
      label: "Original code",
      ref: "original",
      command: "pnpm vitest run src/lib/ratings.test.ts",
      exitCode: 1,
      durationMs: 1229,
      tests: [{ name: liveRatingsTest, status: "failed", durationMs: 39, error: "AssertionError: expected 3 to be 1 // Object.is equality" }],
      output: ` FAIL  src/lib/ratings.test.ts > getListingRatings > ${liveRatingsTest}\nAssertionError: expected 3 to be 1 // Object.is equality\n\n- Expected\n+ Received\n\n- 1\n+ 3\n\n Test Files  1 failed (1)\n      Tests  1 failed (1)\n\nexit code 1`,
    },
    {
      label: "Patched code",
      ref: "patched",
      command: "pnpm vitest run src/lib/ratings.test.ts",
      exitCode: 0,
      durationMs: 1187,
      tests: [{ name: liveRatingsTest, status: "passed", durationMs: 37 }],
      output: ` ✓ src/lib/ratings.test.ts > getListingRatings > ${liveRatingsTest} 37ms\n\n Test Files  1 passed (1)\n      Tests  1 passed (1)\n\nexit code 0`,
    },
    {
      label: "Patched code: typecheck",
      ref: "patched",
      command: "pnpm tsc --noEmit",
      exitCode: 0,
      durationMs: 4385,
      tests: [],
      output: "No type errors.\n\nexit code 0",
    },
  ],
  approval: {
    state: "pending",
    requestedAt: "2026-11-02T00:28:02Z",
  },
};
liveRatings.mitigation = proposeMitigation(
  liveRatings.report!,
  liveRatings.evidence,
  liveRatings.service,
  "2026-11-02T00:27:10Z",
);

// Examples shown alongside real runs: three by hand, one cut from a run.
export const exampleIncidents = [poolLeak, controlRun, priceGap, liveRatings].map((i) => incidentSchema.parse(i));
