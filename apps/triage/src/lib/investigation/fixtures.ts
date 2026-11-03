import { proposeMitigation } from "./mitigation/propose";
import { badDeploy as badDeployScenario } from "./scenarios/bad-deploy";
import { badDeployFiles } from "./scenarios/bad-deploy-files";
import { trafficRush as trafficRushScenario } from "./scenarios/traffic-rush";
import { trafficRushFiles } from "./scenarios/traffic-rush-files";
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

// The fourth fault, a bad code deploy, cut down from the watch-opened run
// of Nov 2 the bad-deploy scenario records (Muse Spark 1.3, high effort):
// its steps, evidence, report, rollback and verification, trimmed to what
// the diagnosis rests on. The series and the code come from the scenario so
// the example stays in step with it. The run's fix was not kept: the model
// edited money.ts without reading it first, and the sandbox refused it.
const badDeployAt = "2026-11-02T06:28:15.734Z";
const badDeployTypeError = "Currency code is required with currency style.";
const badDeployRelease = "feat(shopfront): return a formatted price from the product API";
const badDeploySeries = (metric: string) => badDeployScenario.metrics.find((m) => m.name === metric)!.points.slice(-30);
const badDeployErrorsMetric = "http.server.error_ratio{route=/api/products/[id]}";

const badDeploy: Incident = {
  id: "inc_bad_deploy",
  title: "Error rate above 5% on GET /api/products/[id]",
  service: "shopfront",
  severity: "sev2",
  status: "resolved",
  detectedAt: badDeployAt,
  openedBy: "watch",
  trigger: {
    metric: badDeployErrorsMetric,
    unit: "ratio",
    threshold: 0.05,
    observed: 1,
    series: badDeploySeries(badDeployErrorsMetric),
    rule: { id: "errors", name: "Server errors", description: "error rate over 5% on each route" },
    route: "/api/products/[id]",
  },
  steps: [
    {
      id: "step_1",
      tool: "query_metrics",
      input: {
        metrics: [badDeployErrorsMetric, "http.server.request.duration.p95{route=/api/products/[id]}", "http.server.request.rate"],
        windowMinutes: 30,
      },
      status: "completed",
      startedAt: "2026-11-02T06:28:17.880Z",
      durationMs: 60,
      summary: "Every product API request fails since 06:28; latency and traffic unchanged",
      evidenceIds: ["ev_metric_errors", "ev_metric_p95", "ev_metric_rate"],
    },
    {
      id: "step_2",
      tool: "query_logs",
      input: { service: "shopfront", minLevel: "error", windowMinutes: 30 },
      status: "completed",
      startedAt: "2026-11-02T06:28:17.883Z",
      durationMs: 57,
      summary: "9 TypeErrors 'Currency code is required with currency style.' since 06:27:59, one per failed request",
      evidenceIds: ["ev_log_typeerror", "ev_log_failed"],
    },
    {
      id: "step_3",
      tool: "query_traces",
      input: { service: "shopfront", route: "/api/products/[id]", limit: 5, windowMinutes: 30 },
      status: "completed",
      startedAt: "2026-11-02T06:28:17.887Z",
      durationMs: 53,
      summary: "Failing requests run both queries, then throw the TypeError; the same route answered 200 a few seconds earlier",
      evidenceIds: ["ev_span_failed", "ev_span_ok"],
    },
    {
      id: "step_4",
      tool: "deploy_history",
      input: { service: "shopfront", sinceMinutes: 1440 },
      status: "completed",
      startedAt: "2026-11-02T06:28:17.935Z",
      durationMs: 121,
      summary: "0dfdbac deployed at 06:27:57 from shopfront-release/formatted-price, 18 s before the alert",
      evidenceIds: ["ev_commit_deploy"],
    },
    {
      id: "step_5",
      tool: "git_log",
      input: { path: "src/lib/money.ts", limit: 10 },
      status: "completed",
      startedAt: "2026-11-02T06:28:21.131Z",
      durationMs: 70,
      summary: "money.ts is new in 0dfdbac",
      evidenceIds: ["ev_commit_money"],
    },
    {
      id: "step_6",
      tool: "read_source",
      input: { path: "src/lib/money.ts" },
      status: "completed",
      startedAt: "2026-11-02T06:28:21.131Z",
      durationMs: 65,
      summary: "formatPrice builds an Intl.NumberFormat in currency style with the currency from STORE_CURRENCY",
      evidenceIds: ["ev_source_money"],
    },
    {
      id: "step_7",
      tool: "read_source",
      input: { path: "src/app/api/products/[id]/route.ts" },
      status: "completed",
      startedAt: "2026-11-02T06:28:21.132Z",
      durationMs: 65,
      summary: "The product API now returns price: formatPrice(priceCents) on every response",
      evidenceIds: ["ev_source_route"],
    },
    {
      id: "step_8",
      tool: "query_metrics",
      input: { metrics: ["db.client.connection.count{state=used}", "http.server.error_ratio{route=/api/products}"], windowMinutes: 60 },
      status: "completed",
      startedAt: "2026-11-02T06:28:21.133Z",
      durationMs: 32,
      summary: "1 of 10 connections in use; the product list has no errors",
      evidenceIds: ["ev_metric_pool", "ev_metric_list_errors"],
    },
    {
      id: "step_9",
      tool: "db_diagnostics",
      input: { check: "locks" },
      status: "completed",
      startedAt: "2026-11-02T06:28:25.676Z",
      durationMs: 46,
      summary: "No blocked queries",
      evidenceIds: ["ev_db_locks"],
    },
  ],
  evidence: [
    {
      id: "ev_metric_errors",
      kind: "metric",
      tool: "query_metrics",
      summary: `${badDeployErrorsMetric}: baseline 0 -> now 1 ratio (peak 1 at 06:28)`,
      metric: badDeployErrorsMetric,
      unit: "ratio",
      baseline: 0,
      observed: 1,
      series: badDeploySeries(badDeployErrorsMetric),
    },
    {
      id: "ev_metric_p95",
      kind: "metric",
      tool: "query_metrics",
      summary: "http.server.request.duration.p95{route=/api/products/[id]}: baseline 45.1 -> now 68.23 ms (peak 496 at 06:20)",
      metric: "http.server.request.duration.p95{route=/api/products/[id]}",
      unit: "ms",
      baseline: 45.1,
      observed: 68.23,
      series: badDeploySeries("http.server.request.duration.p95{route=/api/products/[id]}"),
    },
    {
      id: "ev_metric_rate",
      kind: "metric",
      tool: "query_metrics",
      summary: "http.server.request.rate: baseline 0.6 -> now 0.83 req/s (peak 2 at 06:22)",
      metric: "http.server.request.rate",
      unit: "req/s",
      baseline: 0.6,
      observed: 0.83,
      series: badDeploySeries("http.server.request.rate"),
    },
    {
      id: "ev_log_typeerror",
      kind: "log",
      tool: "query_logs",
      summary: `9x error 'TypeError: ${badDeployTypeError}' (06:27 to 06:28)`,
      observedAt: "2026-11-02T06:28:15.112Z",
      service: "shopfront",
      level: "error",
      message: `TypeError: ${badDeployTypeError}`,
      count: 9,
      traceId: "88bc9ad8eb7fdc712f08b6174bae27af",
    },
    {
      id: "ev_log_failed",
      kind: "log",
      tool: "query_logs",
      summary: "2x error 'request failed {\"http.request.method\":\"GET\",\"url.path\":\"/api/products…' (06:27 to 06:28)",
      observedAt: "2026-11-02T06:28:11.777Z",
      service: "shopfront",
      level: "error",
      message: `request failed {"http.request.method":"GET","url.path":"/api/products/1","http.route":"/api/products/[id]","next.route_type":"route","error.type":"TypeError","error.message":"${badDeployTypeError}"}`,
      count: 2,
      traceId: "ea160440c5872daac6176156cf93b9a1",
    },
    {
      id: "ev_span_failed",
      kind: "span",
      tool: "query_traces",
      summary: "shopfront GET /api/products/[id] 76 ms error at 06:27",
      observedAt: "2026-11-02T06:27:59.383Z",
      service: "shopfront",
      traceId: "4235c3620e681340581f2d27ad06a2d8",
      name: "GET /api/products/[id]",
      durationMs: 76.4,
      status: "error",
      attributes: {
        "http.response.status_code": 500,
        "url.path": "/api/products/1",
        "db.client.connection.wait_time_ms": 0.6,
        "db.queries": 2,
        "error.type": "TypeError",
        "exception.message": badDeployTypeError,
      },
    },
    {
      id: "ev_span_ok",
      kind: "span",
      tool: "query_traces",
      summary: "shopfront GET /api/products/[id] 45 ms ok at 06:27",
      observedAt: "2026-11-02T06:27:52.081Z",
      service: "shopfront",
      traceId: "357523dd74983530c6b82132e3357525",
      name: "GET /api/products/[id]",
      durationMs: 45.1,
      status: "ok",
      attributes: { "http.response.status_code": 200, "url.path": "/api/products/1", "db.client.connection.wait_time_ms": 0.6, "db.queries": 2 },
    },
    {
      id: "ev_commit_deploy",
      kind: "commit",
      tool: "deploy_history",
      summary: `Deployed 0dfdbac to shopfront at 06:27: '${badDeployRelease}'`,
      observedAt: "2026-11-02T06:27:57.790Z",
      sha: "0dfdbac",
      author: "teapot2",
      message: badDeployRelease,
      files: ["src/app/api/products/[id]/route.ts", "src/lib/money.ts"],
      deployKind: "deploy",
      branch: "shopfront-release/formatted-price",
    },
    {
      id: "ev_commit_money",
      kind: "commit",
      tool: "git_log",
      summary: `0dfdbac '${badDeployRelease}' by teapot2 at 05:47`,
      observedAt: "2026-11-02T05:47:51.000Z",
      sha: "0dfdbac",
      author: "teapot2",
      message: badDeployRelease,
      files: ["src/lib/money.ts"],
    },
    {
      id: "ev_source_money",
      kind: "source",
      tool: "read_source",
      summary: "formatPrice defaults the currency to STORE_CURRENCY and hands it to Intl.NumberFormat in currency style",
      file: "src/lib/money.ts",
      startLine: 1,
      code: badDeployFiles["src/lib/money.ts"].trimEnd(),
    },
    {
      id: "ev_source_route",
      kind: "source",
      tool: "read_source",
      summary: "The product API formats the price on every response",
      file: "src/app/api/products/[id]/route.ts",
      startLine: 21,
      code: `  if (!product) return Response.json({ error: "not found" }, { status: 404 });
  const priceCents = await priceOf(product);
  const stock = await getStockLevel(product.id);
  return Response.json({ ...product, priceCents, price: formatPrice(priceCents), stock });
}`,
    },
    {
      id: "ev_metric_pool",
      kind: "metric",
      tool: "query_metrics",
      summary: "db.client.connection.count{state=used}: baseline 1 -> now 1 connections (peak 1 at 06:20)",
      metric: "db.client.connection.count{state=used}",
      unit: "connections",
      baseline: 1,
      observed: 1,
      series: badDeploySeries("db.client.connection.count{state=used}"),
    },
    {
      id: "ev_metric_list_errors",
      kind: "metric",
      tool: "query_metrics",
      summary: "http.server.error_ratio{route=/api/products}: baseline 0 -> now 0 ratio (peak 0 at 05:59)",
      metric: "http.server.error_ratio{route=/api/products}",
      unit: "ratio",
      baseline: 0,
      observed: 0,
      series: badDeploySeries("http.server.error_ratio{route=/api/products}"),
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
  ],
  report: {
    summary:
      "Every GET /api/products/[id] has failed since 0dfdbac was deployed at 06:27:57: the release formats the price with Intl.NumberFormat in currency style, and the store has no STORE_CURRENCY, so the handler throws. Roll back 0dfdbac, or set STORE_CURRENCY before deploying it again.",
    servicesQueried: ["shopfront", "postgres"],
    hypotheses: [
      {
        id: "h_bad_deploy",
        title: "formatPrice from deploy 0dfdbac throws without STORE_CURRENCY",
        confidence: 0.9,
        status: "leading",
        causalChain: {
          symptom: {
            text: "The product API's error ratio went from 0 to 1 in the minute after 06:27:57, with latency and traffic unchanged.",
            evidenceIds: ["ev_metric_errors", "ev_metric_p95", "ev_metric_rate"],
          },
          propagation: {
            text: "Every request since reads the product and its stock, then throws TypeError: Currency code is required with currency style. formatting the price, and answers 500.",
            evidenceIds: ["ev_log_typeerror", "ev_log_failed", "ev_span_failed", "ev_span_ok"],
          },
          rootCause: {
            text: "Release 0dfdbac, deployed at 06:27:57, added formatPrice, which calls Intl.NumberFormat with style currency and the currency from STORE_CURRENCY; the store has no STORE_CURRENCY, so the currency is undefined and the formatter throws on every call.",
            evidenceIds: ["ev_commit_deploy", "ev_commit_money", "ev_source_money", "ev_source_route"],
          },
        },
      },
      {
        id: "h_pool",
        title: "Connection pool exhaustion",
        confidence: 0.05,
        status: "rejected",
        causalChain: {
          symptom: { text: "The product API answers 500 on every request.", evidenceIds: ["ev_metric_errors"] },
          propagation: {
            text: "A full pool would leave requests waiting for a connection, but the failing requests waited under a millisecond.",
            evidenceIds: ["ev_span_failed"],
          },
          rootCause: { text: "Nothing holds connections: 1 of 10 is in use.", evidenceIds: ["ev_metric_pool"] },
        },
        rejectedBecause: {
          text: "The pool stayed at 1 of 10, no query was blocked, and the failing request's two queries succeeded before it threw.",
          evidenceIds: ["ev_metric_pool", "ev_db_locks", "ev_span_failed"],
        },
      },
      {
        id: "h_data",
        title: "A product without a price or stock row",
        confidence: 0.05,
        status: "rejected",
        causalChain: {
          symptom: { text: "The product API answers 500 on every request.", evidenceIds: ["ev_metric_errors"] },
          propagation: {
            text: "A missing row would fail some products, but every product id fails with the same TypeError.",
            evidenceIds: ["ev_log_typeerror"],
          },
          rootCause: { text: "A row the handler reads is missing for the products requested.", evidenceIds: ["ev_log_failed"] },
        },
        rejectedBecause: {
          text: "Products 1 to 12 and 61 to 63 all fail, the product list that reads the same rows has no errors, and the error is thrown formatting the price, after both queries returned.",
          evidenceIds: ["ev_log_typeerror", "ev_metric_list_errors", "ev_span_failed"],
        },
      },
    ],
    verdict: { kind: "root_cause", hypothesisId: "h_bad_deploy" },
  },
  mitigation: {
    kind: "rollback",
    target: "0dfdbac",
    branch: "shopfront-release/formatted-price",
    title: "Roll back shopfront to the deploy before 0dfdbac",
    why: { text: "The symptom began after 0dfdbac was deployed to shopfront.", evidenceIds: ["ev_commit_deploy"] },
    steps: ["Roll back 0dfdbac on shopfront"],
    undo: "Redeploy 0dfdbac",
    risk: "low",
    state: "applied",
    proposedAt: "2026-11-02T06:28:40.274Z",
    decidedAt: "2026-11-02T06:28:43.981Z",
    appliedAt: "2026-11-02T06:28:44.259Z",
    output: "rolled back 0dfdbac",
    recovery: {
      metric: badDeployErrorsMetric,
      threshold: 0.05,
      since: "2026-11-02T06:28:44.259Z",
      series: series("2026-11-02T06:29:00Z", [0, 0]),
      status: "recovered",
      recoveredAt: "2026-11-02T06:29:00.000Z",
      checkedAt: "2026-11-02T06:31:00.194Z",
    },
  },
  verification: {
    after: "mitigation",
    since: "2026-11-02T06:29:00.000Z",
    windowMinutes: 5,
    metric: badDeployErrorsMetric,
    threshold: 0.05,
    series: series("2026-11-02T06:30:00Z", [0, 0, 0, 0, 0]),
    status: "resolved",
    startedAt: "2026-11-02T06:31:00.285Z",
    checkedAt: "2026-11-02T06:35:01.705Z",
    finishedAt: "2026-11-02T06:35:01.705Z",
  },
  resolvedAt: "2026-11-02T06:34:00.000Z",
};

// The traffic-rush run as it happened: the wrong answer, kept as a record of
// the trap. The run's stock-leak hypothesis (rejected on the flat pool) is
// left out; the three that carry the story stay, with their recorded ids.
const trafficRushAt = "2026-11-02T07:21:38.279Z";
const trafficRushHomeMetric = "http.server.request.duration.p95{route=/}";
const trafficRushSeries = (metric: string) => trafficRushScenario.metrics.find((m) => m.name === metric)!.points.slice(-30);
const trafficRushMetric = (id: string, metric: string, unit: string, baseline: number, observed: number, peak: string): Incident["evidence"][number] => ({
  id,
  kind: "metric",
  tool: "query_metrics",
  summary: `${metric}: baseline ${baseline} -> now ${observed} ${unit} (peak ${peak})`,
  metric,
  unit,
  baseline,
  observed,
  series: trafficRushSeries(metric),
});
// Lines `from` to `to` of a file the scenario serves, as read_source cites them.
const trafficRushExcerpt = (file: string, from: number, to: number) =>
  trafficRushFiles[file]
    .split("\n")
    .slice(from - 1, to)
    .join("\n");

const trafficRush: Incident = {
  id: "inc_traffic_rush",
  title: "More than 3 requests slower than 1500 ms on GET /",
  service: "shopfront",
  severity: "sev3",
  status: "diagnosed",
  detectedAt: trafficRushAt,
  openedBy: "watch",
  trigger: {
    metric: trafficRushHomeMetric,
    unit: "ms",
    threshold: 1500,
    observed: 1543.3,
    series: trafficRushSeries(trafficRushHomeMetric),
    rule: { id: "page-latency", name: "Page latency", description: "more than 3 requests slower than 1500 ms on each page" },
    route: "/",
  },
  steps: [
    {
      id: "step_1",
      tool: "query_metrics",
      input: { metrics: [trafficRushHomeMetric, "http.server.error_ratio{route=/}", "http.server.request.rate", "http.server.error_ratio"], windowMinutes: 30 },
      status: "completed",
      startedAt: "2026-11-02T07:21:40.917Z",
      durationMs: 37,
      summary: "Home page p95 climbed from 350 ms to 1543 ms over the last five minutes as the request rate went from 2 to 5.6 req/s; no errors",
      evidenceIds: ["ev_metric_home_p95", "ev_metric_home_errors", "ev_metric_rate", "ev_metric_errors"],
    },
    {
      id: "step_2",
      tool: "query_logs",
      input: { service: "shopfront", minLevel: "info", windowMinutes: 30 },
      status: "completed",
      startedAt: "2026-11-02T07:21:40.921Z",
      durationMs: 41,
      summary: "Every route answers 200; 19 slow-request warnings on the home page since 07:14",
      evidenceIds: ["ev_log_home_requests", "ev_log_stock_missing", "ev_log_slow_home"],
    },
    {
      id: "step_3",
      tool: "query_traces",
      input: { service: "shopfront", route: "/", minDurationMs: 1000, limit: 10, windowMinutes: 30 },
      status: "completed",
      startedAt: "2026-11-02T07:21:40.924Z",
      durationMs: 29,
      summary: "Home pages of 1.5 to 1.7 s, each with four queries and under 35 ms waiting for a connection; the journal page took 2 s with no query at all",
      evidenceIds: ["ev_span_journal", "ev_span_home_1", "ev_span_home_2", "ev_span_home_3"],
    },
    {
      id: "step_4",
      tool: "db_diagnostics",
      input: { check: "slow_queries" },
      status: "completed",
      startedAt: "2026-11-02T07:21:44.230Z",
      durationMs: 58,
      summary: "Every statement that ran in the window is a fraction of a millisecond; the reviews copy at the bottom of the list ran 0 times since 07:06",
      evidenceIds: ["ev_db_slow_queries"],
    },
    {
      id: "step_5",
      tool: "query_metrics",
      input: { metrics: ["db.client.connection.count{state=used}", "db.client.connection.count{state=idle}", "db.client.connection.pending_requests"], windowMinutes: 30 },
      status: "completed",
      startedAt: "2026-11-02T07:21:44.233Z",
      durationMs: 12,
      summary: "1 to 2 of 10 connections in use, at most 2 requests waiting",
      evidenceIds: ["ev_metric_pool_used", "ev_metric_pool_idle", "ev_metric_pending"],
    },
    {
      id: "step_6",
      tool: "query_metrics",
      input: { metrics: ["http.server.request.duration.p95{route=/products/[id]}", "http.server.request.duration.p95{route=/journal}", "nodejs.eventloop.utilization"], windowMinutes: 30 },
      status: "completed",
      startedAt: "2026-11-02T07:21:47.530Z",
      durationMs: 14,
      summary: "Product and journal pages slowed with the home page; event loop utilization rose from 0.2 to 0.75",
      evidenceIds: ["ev_metric_product_p95", "ev_metric_journal_p95", "ev_metric_eventloop"],
    },
    {
      id: "step_7",
      tool: "query_logs",
      input: { service: "shopfront", minLevel: "error", windowMinutes: 30 },
      status: "completed",
      startedAt: "2026-11-02T07:21:47.533Z",
      durationMs: 9,
      summary: "No error logs",
      evidenceIds: [],
    },
    {
      id: "step_8",
      tool: "db_diagnostics",
      input: { check: "activity" },
      status: "completed",
      startedAt: "2026-11-02T07:21:50.544Z",
      durationMs: 61,
      summary: "Four idle connections, none in a query",
      evidenceIds: ["ev_db_activity"],
    },
    {
      id: "step_9",
      tool: "db_diagnostics",
      input: { check: "locks" },
      status: "completed",
      startedAt: "2026-11-02T07:21:50.546Z",
      durationMs: 55,
      summary: "No blocked queries",
      evidenceIds: ["ev_db_locks"],
    },
    {
      id: "step_10",
      tool: "deploy_history",
      input: { service: "shopfront", sinceMinutes: 1440 },
      status: "completed",
      startedAt: "2026-11-02T07:21:50.549Z",
      durationMs: 8,
      summary: "417b767 deployed at 07:15:58 from shopfront-release/journal-copy, six minutes before the alert",
      evidenceIds: ["ev_commit_deploy"],
    },
    {
      id: "step_11",
      tool: "git_log",
      input: { limit: 20 },
      status: "completed",
      startedAt: "2026-11-02T07:21:50.551Z",
      durationMs: 94,
      summary: "417b767 touches the journal page only; e5ac370 added live ratings behind FF_LIVE_RATINGS",
      evidenceIds: ["ev_commit_journal", "ev_commit_rerun", "ev_commit_ratings"],
    },
    {
      id: "step_12",
      tool: "read_source",
      input: { path: "src/lib/ratings.ts" },
      status: "completed",
      startedAt: "2026-11-02T07:21:53.561Z",
      durationMs: 3,
      summary: "getListingRatings reads the stored ratings in one query, or with FF_LIVE_RATINGS on averages each product's reviews in a loop",
      evidenceIds: ["ev_source_ratings"],
    },
    {
      id: "step_13",
      tool: "read_source",
      input: { path: "src/app/(store)/page.tsx" },
      status: "completed",
      startedAt: "2026-11-02T07:21:53.563Z",
      durationMs: 3,
      summary: "The home page lists products through withListingRatings, for the grid and the new arrivals",
      evidenceIds: ["ev_source_home"],
    },
    {
      id: "step_14",
      tool: "read_source",
      input: { path: "src/lib/flags.ts" },
      status: "completed",
      startedAt: "2026-11-02T07:21:53.565Z",
      durationMs: 2,
      summary: "Flags come from the environment and can be flipped at runtime",
      evidenceIds: ["ev_source_flags"],
    },
    {
      id: "step_15",
      tool: "read_source",
      input: { path: "src/db/seed.ts" },
      status: "completed",
      startedAt: "2026-11-02T07:21:59.258Z",
      durationMs: 2,
      summary: "The seed writes 50,000 reviews per product",
      evidenceIds: ["ev_source_seed"],
    },
    {
      id: "step_16",
      tool: "read_source",
      input: { path: "drizzle/0005_reviews.sql" },
      status: "completed",
      startedAt: "2026-11-02T07:21:59.260Z",
      durationMs: 2,
      summary: "The reviews table is indexed by product_id",
      evidenceIds: ["ev_source_reviews_migration"],
    },
    {
      id: "step_17",
      tool: "query_metrics",
      input: { metrics: ["http.server.request.duration.p95{route=/api/products}", "http.server.request.duration.p95{route=/api/health}", "http.server.request.duration.p95{route=/cart}"], windowMinutes: 30 },
      status: "completed",
      startedAt: "2026-11-02T07:22:09.740Z",
      durationMs: 11,
      summary: "The product API and the health check stay fast; the cart page slowed like the other pages",
      evidenceIds: ["ev_metric_api_list_p95", "ev_metric_health_p95", "ev_metric_cart_p95"],
    },
    {
      id: "step_18",
      tool: "read_source",
      input: { path: "src/app/(store)/journal/page.tsx" },
      status: "completed",
      startedAt: "2026-11-02T07:22:09.743Z",
      durationMs: 2,
      summary: "The journal page is static: no database, no flag",
      evidenceIds: ["ev_source_journal"],
    },
    {
      id: "step_19",
      tool: "query_logs",
      input: { service: "shopfront", contains: "flags: loaded", windowMinutes: 180 },
      status: "completed",
      startedAt: "2026-11-02T07:22:14.225Z",
      durationMs: 7,
      summary: "At the 07:08 restart every flag loaded off, FF_LIVE_RATINGS included",
      evidenceIds: ["ev_log_flags"],
    },
    {
      id: "step_20",
      tool: "query_logs",
      input: { service: "shopfront", minLevel: "warn", windowMinutes: 30 },
      status: "completed",
      startedAt: "2026-11-02T07:22:14.228Z",
      durationMs: 12,
      summary: "The slow-request warnings and the one deploy; no flag was flipped in the window",
      evidenceIds: ["ev_log_slow_home", "ev_log_slow_product", "ev_log_deploy"],
    },
    {
      id: "step_21",
      tool: "git_log",
      input: { path: "src/lib/ratings.ts", limit: 5 },
      status: "completed",
      startedAt: "2026-11-02T07:22:21.156Z",
      durationMs: 88,
      summary: "ratings.ts has one commit, e5ac370, a day before",
      evidenceIds: ["ev_commit_ratings"],
    },
    {
      id: "step_22",
      tool: "read_source",
      input: { path: "src/lib/access-log.ts" },
      status: "completed",
      startedAt: "2026-11-02T07:22:21.159Z",
      durationMs: 2,
      summary: "The access log warns on requests past 1000 ms",
      evidenceIds: ["ev_source_access_log"],
    },
  ],
  thoughts: [
    {
      id: "th_125e0b43",
      startedAt: "2026-11-02T07:21:38.357Z",
      reasoningKind: "summary",
      text: "Investigating that slow homepage alert — pulling latency, errors, and traces now.",
      durationMs: 2559,
    },
    {
      id: "th_ca1d2a5e",
      startedAt: "2026-11-02T07:21:40.979Z",
      reasoning: "Analyzing route latency against the request rate, checking metrics, logs, the database and deployment history for the cause.",
      reasoningKind: "summary",
      text: "Homepage p95 is spiking with no errors, and the request rate has more than doubled — now digging into the database and recent changes.",
      durationMs: 3224,
    },
    {
      id: "th_4538416c",
      startedAt: "2026-11-02T07:21:53.555Z",
      reasoning:
        "Reading the slow-query window: every app statement is a fraction of a millisecond, and the reviews copy at the bottom of the list ran zero times in the window.\n\nChecking the flag states from the brief and the journal deploy against the timing.",
      reasoningKind: "summary",
      text: "Nothing in the database is slow in the window. Checking whether the journal deploy or a flag explains the timing, or whether it's the load alone.",
      durationMs: 5640,
    },
    {
      id: "th_46542f62",
      startedAt: "2026-11-02T07:22:21.150Z",
      reasoning:
        "Correlating event-loop utilization and the request rate with the slowdown across every page, the static journal page included.\n\nRuling out the pool: one to two of ten connections used, at most two waiting.",
      reasoningKind: "summary",
      text: "Flags are all off and the deploy touched one sentence of static copy — yet every page slowed together, the journal page included. The server is saturated by the traffic.",
      durationMs: 13657,
    },
    {
      id: "th_480bebcc",
      startedAt: "2026-11-02T07:23:06.798Z",
      reasoning:
        "Weighing three hypotheses: the load alone, the live-ratings loop and the journal deploy.\n\nRejecting the ratings loop (every flag off since the 07:08 restart, zero reviews queries in the window) and the deploy (static copy, and the journal page slowed like every other).\n\nConcluding the single Node process is saturated by the doubled request rate, with no file at fault and nothing to undo.",
      reasoningKind: "summary",
      durationMs: 38121,
    },
  ],
  evidence: [
    trafficRushMetric("ev_metric_home_p95", trafficRushHomeMetric, "ms", 589.68, 1543.3, "1543.3 at 07:21"),
    trafficRushMetric("ev_metric_home_errors", "http.server.error_ratio{route=/}", "ratio", 0, 0, "0 at 06:37"),
    trafficRushMetric("ev_metric_rate", "http.server.request.rate", "req/s", 2.28, 5.64, "5.64 at 07:21"),
    trafficRushMetric("ev_metric_errors", "http.server.error_ratio", "ratio", 0, 0, "0 at 06:37"),
    {
      id: "ev_log_home_requests",
      kind: "log",
      tool: "query_logs",
      summary: "845x info 'GET / 200 {\"http.request.method\":\"GET\",\"http.route\":\"/\",\"http.respons…' (06:37 to 07:21)",
      observedAt: "2026-11-02T07:21:34.144Z",
      service: "shopfront",
      level: "info",
      message: 'GET / 200 {"http.request.method":"GET","http.route":"/","http.response.status_code":<n>,"url.path":"/","duration_ms":<n>}',
      count: 845,
      traceId: "ceabd09e381338c1c00a8a3205f4bf4b",
    },
    {
      id: "ev_log_stock_missing",
      kind: "log",
      tool: "query_logs",
      summary: "602x info 'stock row missing, returning default {\"product.id\":<n>}' (06:37 to 07:21)",
      observedAt: "2026-11-02T07:21:37.174Z",
      service: "shopfront",
      level: "info",
      message: 'stock row missing, returning default {"product.id":<n>}',
      count: 602,
      traceId: "8e5025aa245b122c748849c56329abae",
    },
    {
      id: "ev_log_slow_home",
      kind: "log",
      tool: "query_logs",
      summary: "19x warn 'slow request {\"http.request.method\":\"GET\",\"http.route\":\"/\",\"http.resp…' (07:14 to 07:21)",
      observedAt: "2026-11-02T07:21:30.194Z",
      service: "shopfront",
      level: "warn",
      message: 'slow request {"http.request.method":"GET","http.route":"/","http.response.status_code":<n>,"url.path":"/","duration_ms":<n>}',
      count: 19,
      traceId: "12f953b18b3b1a3fb1b7dbf18ee8e8f1",
    },
    {
      id: "ev_span_journal",
      kind: "span",
      tool: "query_traces",
      summary: "shopfront GET /journal 2005 ms ok at 07:21",
      observedAt: "2026-11-02T07:21:35.670Z",
      service: "shopfront",
      traceId: "d6cdaa7ac2162ee694b6f4b57079b6c5",
      name: "GET /journal",
      durationMs: 2005.3,
      status: "ok",
      attributes: { "http.response.status_code": 200, "url.path": "/journal" },
    },
    {
      id: "ev_span_home_1",
      kind: "span",
      tool: "query_traces",
      summary: "shopfront GET / 1702 ms ok at 07:21",
      observedAt: "2026-11-02T07:21:21.553Z",
      service: "shopfront",
      traceId: "25cd0df70a96584cf995bd26b5539655",
      name: "GET /",
      durationMs: 1701.7,
      status: "ok",
      attributes: { "http.response.status_code": 200, "url.path": "/", "db.client.connection.wait_time_ms": 27.9, "db.queries": 4 },
    },
    {
      id: "ev_span_home_2",
      kind: "span",
      tool: "query_traces",
      summary: "shopfront GET / 1684 ms ok at 07:21",
      observedAt: "2026-11-02T07:21:28.508Z",
      service: "shopfront",
      traceId: "5467cf9bac2ce4dcc8922d2ef5a2ae70",
      name: "GET /",
      durationMs: 1684,
      status: "ok",
      attributes: { "http.response.status_code": 200, "url.path": "/", "db.client.connection.wait_time_ms": 31.2, "db.queries": 4 },
    },
    {
      id: "ev_span_home_3",
      kind: "span",
      tool: "query_traces",
      summary: "shopfront GET / 1543 ms ok at 07:21",
      observedAt: "2026-11-02T07:21:05.472Z",
      service: "shopfront",
      traceId: "49515c83d29e0cd44408327e4cb40e39",
      name: "GET /",
      durationMs: 1543.3,
      status: "ok",
      attributes: { "http.response.status_code": 200, "url.path": "/", "db.client.connection.wait_time_ms": 26.9, "db.queries": 4 },
    },
    {
      id: "ev_db_slow_queries",
      kind: "db",
      tool: "db_diagnostics",
      summary: `slow_queries: 5 rows; ${trafficRushScenario.db.slow_queries.note}`,
      query: trafficRushScenario.db.slow_queries.query,
      rows: trafficRushScenario.db.slow_queries.rows,
    },
    trafficRushMetric("ev_metric_pool_used", "db.client.connection.count{state=used}", "connections", 1, 1, "2 at 07:17"),
    trafficRushMetric("ev_metric_pool_idle", "db.client.connection.count{state=idle}", "connections", 1, 3, "3 at 06:38"),
    trafficRushMetric("ev_metric_pending", "db.client.connection.pending_requests", "requests", 2, 1, "2 at 06:38"),
    trafficRushMetric("ev_metric_product_p95", "http.server.request.duration.p95{route=/products/[id]}", "ms", 501.9, 1191.34, "1191.34 at 07:21"),
    trafficRushMetric("ev_metric_journal_p95", "http.server.request.duration.p95{route=/journal}", "ms", 65.33, 2005.31, "2005.31 at 07:21"),
    trafficRushMetric("ev_metric_eventloop", "nodejs.eventloop.utilization", "ratio", 0.2, 0.75, "0.75 at 07:21"),
    {
      id: "ev_db_activity",
      kind: "db",
      tool: "db_diagnostics",
      summary: "activity: 4 rows",
      query: trafficRushScenario.db.activity.query,
      rows: trafficRushScenario.db.activity.rows,
    },
    {
      id: "ev_db_locks",
      kind: "db",
      tool: "db_diagnostics",
      summary: "locks: no rows",
      query: trafficRushScenario.db.locks.query,
      rows: [],
    },
    {
      id: "ev_commit_deploy",
      kind: "commit",
      tool: "deploy_history",
      summary: "Deployed 417b767 to shopfront at 07:15: 'chore(shopfront): reword the journal page intro'",
      observedAt: "2026-11-02T07:15:58.604Z",
      sha: "417b767",
      author: "teapot2",
      message: "chore(shopfront): reword the journal page intro",
      files: ["src/app/(store)/journal/page.tsx"],
      deployKind: "deploy",
      branch: "shopfront-release/journal-copy",
    },
    {
      id: "ev_commit_journal",
      kind: "commit",
      tool: "git_log",
      summary: "417b767 'chore(shopfront): reword the journal page intro' by teapot2 at 07:11",
      observedAt: "2026-11-02T07:11:21.000Z",
      sha: "417b767",
      author: "teapot2",
      message: "chore(shopfront): reword the journal page intro",
      files: ["src/app/(store)/journal/page.tsx"],
    },
    {
      id: "ev_commit_rerun",
      kind: "commit",
      tool: "git_log",
      summary: "21166f5 'feat: re-run incidents with other models, release rollbacks and web search' by teapot2 at 06:30",
      observedAt: "2026-11-02T06:30:53.000Z",
      sha: "21166f5",
      author: "teapot2",
      message: "feat: re-run incidents with other models, release rollbacks and web search",
      files: trafficRushScenario.commits.find((c) => c.sha === "21166f5")!.files,
    },
    {
      id: "ev_commit_ratings",
      kind: "commit",
      tool: "git_log",
      summary: "e5ac370 'feat(shopfront): live ratings from the reviews table, behind FF_LIVE_RATINGS' by teapot2 at 05:14",
      observedAt: "2026-11-01T05:14:19.000Z",
      sha: "e5ac370",
      author: "teapot2",
      message: "feat(shopfront): live ratings from the reviews table, behind FF_LIVE_RATINGS",
      files: ["src/lib/ratings.ts"],
    },
    {
      id: "ev_source_ratings",
      kind: "source",
      tool: "read_source",
      summary: "src/lib/ratings.ts lines 1-41",
      file: "src/lib/ratings.ts",
      startLine: 1,
      code: trafficRushFiles["src/lib/ratings.ts"].trimEnd(),
    },
    {
      id: "ev_source_home",
      kind: "source",
      tool: "read_source",
      summary: "src/app/(store)/page.tsx lines 30-49: loadProducts lists the grid through withListingRatings",
      file: "src/app/(store)/page.tsx",
      startLine: 30,
      code: trafficRushExcerpt("src/app/(store)/page.tsx", 30, 49),
    },
    {
      id: "ev_source_flags",
      kind: "source",
      tool: "read_source",
      summary: "src/lib/flags.ts lines 23-33: a flag is its env var unless flipped at runtime",
      file: "src/lib/flags.ts",
      startLine: 23,
      code: trafficRushExcerpt("src/lib/flags.ts", 23, 33),
    },
    {
      id: "ev_source_seed",
      kind: "source",
      tool: "read_source",
      summary: "src/db/seed.ts lines 1-9: REVIEWS_PER_PRODUCT = 50_000",
      file: "src/db/seed.ts",
      startLine: 1,
      code: trafficRushExcerpt("src/db/seed.ts", 1, 9),
    },
    {
      id: "ev_source_reviews_migration",
      kind: "source",
      tool: "read_source",
      summary: "drizzle/0005_reviews.sql lines 1-11",
      file: "drizzle/0005_reviews.sql",
      startLine: 1,
      code: trafficRushFiles["drizzle/0005_reviews.sql"].trimEnd(),
    },
    trafficRushMetric("ev_metric_api_list_p95", "http.server.request.duration.p95{route=/api/products}", "ms", 62.84, 135.62, "135.62 at 07:21"),
    trafficRushMetric("ev_metric_health_p95", "http.server.request.duration.p95{route=/api/health}", "ms", 26.13, 6.73, "60.92 at 07:19"),
    trafficRushMetric("ev_metric_cart_p95", "http.server.request.duration.p95{route=/cart}", "ms", 304.91, 884.64, "884.64 at 07:21"),
    {
      id: "ev_source_journal",
      kind: "source",
      tool: "read_source",
      summary: "src/app/(store)/journal/page.tsx lines 42-59: a static page over the posts above it",
      file: "src/app/(store)/journal/page.tsx",
      startLine: 42,
      code: trafficRushExcerpt("src/app/(store)/journal/page.tsx", 42, 59),
    },
    {
      id: "ev_log_flags",
      kind: "log",
      tool: "query_logs",
      summary: "1x info 'flags: loaded {\"flag.FF_STOCK_DIRECT_QUERY\":false,\"flag.FF_LIST_PRICE…' (at 07:08)",
      observedAt: "2026-11-02T07:08:50.632Z",
      service: "shopfront",
      level: "info",
      message: 'flags: loaded {"flag.FF_STOCK_DIRECT_QUERY":false,"flag.FF_LIST_PRICES":false,"flag.FF_LIVE_RATINGS":false}',
      count: 1,
    },
    {
      id: "ev_log_slow_product",
      kind: "log",
      tool: "query_logs",
      summary: "4x warn 'slow request {\"http.request.method\":\"GET\",\"http.route\":\"/products/[id…' (at 07:21)",
      observedAt: "2026-11-02T07:21:30.045Z",
      service: "shopfront",
      level: "warn",
      message: 'slow request {"http.request.method":"GET","http.route":"/products/[id]","http.response.status_code":<n>,"url.path":"/products/1","duration_ms":<n>}',
      count: 4,
      traceId: "3103bc7dde725ccf164a3eae82aa0a65",
    },
    {
      id: "ev_log_deploy",
      kind: "log",
      tool: "query_logs",
      summary: "1x warn 'deploy: 417b767 chore(shopfront): reword the journal page intro {\"dep…' (at 07:15)",
      observedAt: "2026-11-02T07:15:58.604Z",
      service: "shopfront",
      level: "warn",
      message:
        'deploy: 417b767 chore(shopfront): reword the journal page intro {"deploy.sha":"417b767","deploy.message":"chore(shopfront): reword the journal page intro","deploy.kind":"deploy","deploy.branch":"shopfront-release/journal-copy"}',
      count: 1,
      traceId: "5b943b1d72e2283e50336f735d4418ff",
    },
    {
      id: "ev_source_access_log",
      kind: "source",
      tool: "read_source",
      summary: "src/lib/access-log.ts lines 9-11: SLOW_MS = 1000",
      file: "src/lib/access-log.ts",
      startLine: 9,
      code: trafficRushExcerpt("src/lib/access-log.ts", 9, 11),
    },
  ],
  report: {
    summary:
      "Pages slowed because traffic roughly doubled and saturated the server from 07:19 on. The database stayed fast, the flags are off, and the journal edit is static copy.",
    hypotheses: [
      {
        id: "h_load",
        title: "Traffic surge saturates the Node event loop, queuing every render",
        confidence: 0.74,
        status: "leading",
        causalChain: {
          symptom: {
            text: "GET / p95 rose to 1543 ms at 07:21 with 19 slow-request warnings and traces of 1.5 to 1.7 s",
            evidenceIds: ["ev_metric_home_p95", "ev_log_slow_home", "ev_span_home_1", "ev_span_home_2"],
          },
          propagation: {
            text: "The request rate went from 2.3 to 5.6 req/s and event-loop utilization from 0.2 to 0.75; product pages and the database-free journal page slowed with the home page, so the delay is in the shared process, not a route's query",
            evidenceIds: ["ev_metric_rate", "ev_metric_eventloop", "ev_metric_product_p95", "ev_metric_journal_p95", "ev_source_journal"],
          },
          rootCause: {
            text: "More requests than the single Node process serves: renders queue on the event loop while the pool stays at 1 to 2 of 10 connections with at most 2 waiting and every statement in the window is under a millisecond",
            evidenceIds: ["ev_metric_rate", "ev_metric_eventloop", "ev_metric_pool_used", "ev_metric_pending", "ev_db_slow_queries"],
          },
        },
      },
      {
        id: "h_ratings",
        title: "Live-ratings loop over the reviews table",
        confidence: 0.1,
        status: "rejected",
        causalChain: {
          symptom: { text: "Home page p95 breached with 19 slow requests", evidenceIds: ["ev_metric_home_p95", "ev_log_slow_home"] },
          propagation: {
            text: "getListingRatings averages each product's reviews in a loop while FF_LIVE_RATINGS is on",
            evidenceIds: ["ev_source_ratings"],
          },
          rootCause: { text: "The reviews table holds 50,000 rows per product", evidenceIds: ["ev_source_seed"] },
        },
        rejectedBecause: {
          text: "Every flag loaded off at the 07:08 restart and none flipped since; the reviews copy in the statistics ran 0 times in the window",
          evidenceIds: ["ev_log_flags", "ev_db_slow_queries"],
        },
      },
      {
        id: "h_deploy",
        title: "Journal copy deploy caused the slowdown",
        confidence: 0.08,
        status: "rejected",
        causalChain: {
          symptom: { text: "Journal and home latency spike together", evidenceIds: ["ev_metric_journal_p95", "ev_metric_home_p95"] },
          propagation: { text: "The journal intro deployed at 07:15, inside the slow window", evidenceIds: ["ev_commit_deploy", "ev_source_journal"] },
          rootCause: { text: "Commit 417b767 rewording the journal intro introduced a regression", evidenceIds: ["ev_commit_journal"] },
        },
        rejectedBecause: {
          text: "The commit changes one sentence of static copy, and the health API, cart and product pages slowed just as much as the journal",
          evidenceIds: ["ev_commit_journal", "ev_metric_health_p95", "ev_metric_cart_p95", "ev_metric_product_p95"],
        },
      },
      {
        id: "h_noise",
        title: "False alarm on a noisy baseline",
        confidence: 0.08,
        status: "rejected",
        causalChain: {
          symptom: { text: "GET / p95 breach on a low-traffic baseline", evidenceIds: ["ev_metric_home_p95"] },
          propagation: { text: "A few slow renders after a cold start could trip the rule", evidenceIds: ["ev_log_slow_home"] },
          rootCause: { text: "No sustained change behind the breach", evidenceIds: ["ev_metric_rate"] },
        },
        rejectedBecause: {
          text: "19 slow requests over seven minutes across every page, tracking the request rate, is sustained load rather than noise",
          evidenceIds: ["ev_log_slow_home", "ev_metric_rate", "ev_metric_product_p95"],
        },
      },
    ],
    verdict: { kind: "root_cause", hypothesisId: "h_load" },
    servicesQueried: ["postgres", "shopfront"],
  },
  noMitigation: {
    why: "Nothing to undo: the diagnosis cites no flag flip or deploy. If the load itself is the cause, scale out or wait for the rate to settle.",
    at: "2026-11-02T07:23:44.923Z",
  },
};

// Examples shown alongside real runs: three by hand, three cut from runs.
export const exampleIncidents = [poolLeak, controlRun, priceGap, liveRatings, badDeploy, trafficRush].map((i) => incidentSchema.parse(i));
