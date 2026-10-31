import type { MetricPoint } from "../schema";
import type { MetricSeries } from "../source";
import { priceGapFiles } from "./price-gap-files";
import { minutesBefore, type Scenario } from "./scenario-source";
import { commonCommits, services } from "./shopfront-base";

// Shopfront's price list (FF_LIST_PRICES), recorded live on 2026-10-30 under
// the Normal day traffic profile (~2 req/s): the flag went on at 23:18:09Z
// and the Server errors rule opened its incident 44 s later. getListPrice
// reads the product's product_prices row, and the products with no stock row
// (9, 61, 62, 63) have none, because syncListPrices inner-joins stock_levels;
// destructuring the missing row throws. The product API answers 500, the
// product page still answers 200 (its loading.tsx streams the shell first),
// latency and the pool stay where they were.
//
// Values below are what Triage's live source reported at the alert (the
// collector files of that run); the recording only has 7 minutes of traffic
// before the flag, so each baseline repeats those minutes back to the start
// of the window, and steady log counts are scaled to it.

const now = "2026-10-30T23:18:53.000Z";
const flagOnAt = "2026-10-30T23:18:09.363Z";
const window = 45;

// Per-minute points like the live source's: one per minute bucket, the last
// being the bucket `now` is in. `baseline` holds the recorded minutes before
// the flag, oldest first; it repeats back to the start of the window.
const minute = 60_000;
const bucket = Math.floor(Date.parse(now) / minute) * minute;
function recorded(baseline: number[], last: number): MetricPoint[] {
  return Array.from({ length: window }, (_, i) => {
    const minutesAgo = window - 1 - i;
    const back = minutesAgo - 1;
    const value = minutesAgo === 0 ? last : baseline[baseline.length - 1 - (back % baseline.length)];
    return { t: new Date(bucket - minutesAgo * minute).toISOString(), value };
  });
}

const route = (name: string, unit: string, description: string, points: MetricPoint[]): MetricSeries => ({
  name,
  service: "shopfront",
  unit,
  description,
  points,
});
const p95 = (r: string, baseline: number[], last: number) =>
  route(`http.server.request.duration.p95{route=${r}}`, "ms", `p95 latency of ${r}, per minute`, recorded(baseline, last));
const errors = (r: string, last: number) =>
  route(
    `http.server.error_ratio{route=${r}}`,
    "ratio",
    `Share of ${r} responses with status >= 500, per minute`,
    recorded([0], last),
  );

const productsQuery =
  'select "id", "name", "price_cents", "category", "description", "rating_tenths", "review_count", "art", "tint", "created…';
const priceQuery = 'select "amount_cents" from "product_prices" where "product_prices"."product_id" = $1 limit $2';
const stockQuery = 'select "on_hand" from "stock_levels" where "stock_levels"."product_id" = $1 limit $2';
const typeError = "Cannot read properties of undefined (reading 'amountCents')";

export const priceGap: Scenario = {
  id: "price-gap",
  label: "Price list gap",
  description: "500s on the product API right after a config change",
  now,
  alert: {
    title: "Error rate above 5% on GET /api/products/[id]",
    service: "shopfront",
    severity: "sev2",
    metric: "http.server.error_ratio{route=/api/products/[id]}",
    threshold: 0.05,
  },
  services,
  metrics: [
    errors("/api/products/[id]", 0.21),
    errors("/api/products", 0),
    errors("/products/[id]", 0),
    p95("/api/products/[id]", [202.23, 114.87, 256.96, 63.38, 218.59, 227.51], 50.27),
    p95("/api/products", [23.11, 18.68, 130.83, 66.54, 20.49, 69.49], 388.55),
    p95("/products/[id]", [1967.57, 894.22, 1441.37, 2070.3, 837.31, 1732.72], 1807.89),
    route("http.server.request.rate", "req/s", "Requests per second across all routes", recorded([2.28, 2.3, 2.25, 2.13, 1.23, 1.78], 1.81)),
    route("http.server.error_ratio", "ratio", "Share of responses with status >= 500", recorded([0], 0.05)),
    route(
      "db.client.connection.count{state=used}",
      "connections",
      "pg pool connections in this state (pool max 10)",
      recorded([1, 2, 1, 2, 1, 1], 1),
    ),
    route(
      "db.client.connection.count{state=idle}",
      "connections",
      "pg pool connections in this state (pool max 10)",
      recorded([2, 1, 1, 1, 1, 2], 1),
    ),
    route("db.client.connection.max", "connections", "pg pool size limit", recorded([10], 10)),
    route("nodejs.eventloop.utilization", "ratio", "Event loop utilization", recorded([0.51, 0.44, 0.39, 0.75, 0.22, 0.61], 0.22)),
    route(
      "db.client.connection.pending_requests",
      "requests",
      "Requests waiting for a pg pool connection (peak per minute)",
      recorded([4, 2, 2, 3, 2, 2], 2),
    ),
  ],
  logs: [
    {
      service: "shopfront",
      level: "info",
      message: 'fetched product {"product.id":<n>,"product.found":true}',
      count: 784,
      firstSeen: minutesBefore(now, window),
      lastSeen: "2026-10-30T23:18:50.574Z",
      traceId: "74ddb5e14458c3dba5c3c8a34d8f73d8",
    },
    {
      service: "shopfront",
      level: "info",
      message: 'stock row missing, returning default {"product.id":<n>}',
      count: 514,
      firstSeen: minutesBefore(now, window),
      lastSeen: "2026-10-30T23:18:07.841Z",
      traceId: "26bcd931db34723ca7c49f9e4c10d303",
    },
    {
      service: "shopfront",
      level: "info",
      message: 'listed products {"products.count":<n>}',
      count: 373,
      firstSeen: minutesBefore(now, window),
      lastSeen: "2026-10-30T23:18:44.889Z",
      traceId: "f09adcf6215181f46990e39184ee2669",
    },
    {
      service: "shopfront",
      level: "error",
      message: `TypeError: ${typeError}`,
      count: 13,
      firstSeen: "2026-10-30T23:18:11.124Z",
      lastSeen: "2026-10-30T23:18:47.660Z",
      traceId: "530578d1309263b0d7f9c409676bd580",
    },
    {
      service: "shopfront",
      level: "info",
      message: 'fetched product {"product.id":<n>,"product.found":false}',
      count: 6,
      firstSeen: minutesBefore(now, 41),
      lastSeen: minutesBefore(now, 6.8),
    },
    {
      service: "shopfront",
      level: "error",
      message: "23: The operation was aborted due to timeout",
      count: 2,
      firstSeen: "2026-10-30T23:12:45.139Z",
      lastSeen: "2026-10-30T23:12:45.140Z",
    },
    {
      service: "shopfront",
      level: "warn",
      message: 'ops: FF_LIST_PRICES turned on {"flag.name":"FF_LIST_PRICES"}',
      count: 1,
      firstSeen: flagOnAt,
      lastSeen: flagOnAt,
      traceId: "c96e6f547bfd3863d17aa5c27e279270",
    },
  ],
  spans: [
    {
      traceId: "8258393c8d3afea10cfeec326843fe6f",
      service: "shopfront",
      name: "GET /api/products/[id]",
      route: "/api/products/[id]",
      startedAt: "2026-10-30T23:18:40.155Z",
      durationMs: 34.4,
      status: "error",
      attributes: {
        "http.response.status_code": 500,
        "url.path": "/api/products/62",
        "db.client.connection.wait_time_ms": 0.7,
        "db.queries": 2,
        "error.type": "TypeError",
        "exception.message": typeError,
      },
    },
    {
      traceId: "8258393c8d3afea10cfeec326843fe6f",
      service: "postgres",
      name: productsQuery,
      startedAt: "2026-10-30T23:18:40.183Z",
      durationMs: 1.33,
      status: "ok",
      attributes: { "db.system.name": "postgresql", "db.namespace": "shopfront" },
    },
    {
      traceId: "8258393c8d3afea10cfeec326843fe6f",
      service: "postgres",
      name: priceQuery,
      startedAt: "2026-10-30T23:18:40.185Z",
      durationMs: 1.43,
      status: "ok",
      attributes: { "db.system.name": "postgresql", "db.namespace": "shopfront" },
    },
    {
      traceId: "1c6c615aefdd6e1d276fe497d2be8d2b",
      service: "shopfront",
      name: "GET /api/products/[id]",
      route: "/api/products/[id]",
      startedAt: "2026-10-30T23:18:38.535Z",
      durationMs: 31.5,
      status: "error",
      attributes: {
        "http.response.status_code": 500,
        "url.path": "/api/products/63",
        "db.client.connection.wait_time_ms": 0.5,
        "db.queries": 2,
        "error.type": "TypeError",
        "exception.message": typeError,
      },
    },
    {
      traceId: "eaa88d4582c00f402c8e22d12ccaa2f6",
      service: "shopfront",
      name: "GET /api/products/[id]",
      route: "/api/products/[id]",
      startedAt: "2026-10-30T23:18:29.221Z",
      durationMs: 17.5,
      status: "error",
      attributes: {
        "http.response.status_code": 500,
        "url.path": "/api/products/9",
        "db.client.connection.wait_time_ms": 0.8,
        "db.queries": 2,
        "error.type": "TypeError",
        "exception.message": typeError,
      },
    },
    {
      traceId: "e962c945760e983df54bdcae7b1097d7",
      service: "shopfront",
      name: "GET /api/products/[id]",
      route: "/api/products/[id]",
      startedAt: "2026-10-30T23:18:43.372Z",
      durationMs: 31.9,
      status: "ok",
      attributes: {
        "http.response.status_code": 200,
        "url.path": "/api/products/2",
        "db.client.connection.wait_time_ms": 1.3,
        "db.queries": 3,
      },
    },
    {
      traceId: "e962c945760e983df54bdcae7b1097d7",
      service: "postgres",
      name: priceQuery,
      startedAt: "2026-10-30T23:18:43.398Z",
      durationMs: 1.52,
      status: "ok",
      attributes: { "db.system.name": "postgresql", "db.namespace": "shopfront" },
    },
    {
      traceId: "e962c945760e983df54bdcae7b1097d7",
      service: "postgres",
      name: stockQuery,
      startedAt: "2026-10-30T23:18:43.401Z",
      durationMs: 1.14,
      status: "ok",
      attributes: { "db.system.name": "postgresql", "db.namespace": "shopfront" },
    },
    {
      traceId: "d29ccb8dd2932d0623f0ef777448eeca",
      service: "shopfront",
      name: "GET /products/[id]",
      route: "/products/[id]",
      startedAt: "2026-10-30T23:18:40.812Z",
      durationMs: 182.7,
      status: "ok",
      attributes: {
        "http.response.status_code": 200,
        "url.path": "/products/62",
        "db.client.connection.wait_time_ms": 12.5,
        "db.queries": 2,
        "error.type": "TypeError",
        "exception.message": typeError,
      },
    },
    {
      traceId: "c161c721e61fb2379856ef690c3832ac",
      service: "shopfront",
      name: "GET /api/products/[id]",
      route: "/api/products/[id]",
      startedAt: "2026-10-30T23:17:20.904Z",
      durationMs: 227.5,
      status: "ok",
      attributes: {
        "http.response.status_code": 200,
        "url.path": "/api/products/7",
        "db.client.connection.wait_time_ms": 0.7,
        "db.queries": 2,
      },
    },
  ],
  db: {
    activity: {
      query:
        "SELECT pid, application_name, state, to_char(now() - state_change, 'HH24:MI:SS') AS in_state_for, left(query, 60) AS last_query FROM pg_stat_activity WHERE datname = 'shopfront' AND pid <> pg_backend_pid() ORDER BY state_change",
      rows: [
        { pid: 61204, application_name: "", state: "idle", in_state_for: "00:00:02", last_query: 'select "amount_cents" from "product_prices" where "product_p' },
        { pid: 61211, application_name: "", state: "idle", in_state_for: "00:00:00", last_query: 'select "id", "name", "price_cents", "category", "description' },
      ],
    },
    locks: {
      query:
        "SELECT pid, pg_blocking_pids(pid)::text AS blocked_by, left(query, 60) AS query FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0",
      rows: [],
    },
    slow_queries: {
      query:
        "SELECT left(query, 60) AS query, calls, round(mean_exec_time::numeric, 2) AS mean_ms, round(max_exec_time::numeric, 2) AS max_ms FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 5",
      rows: [
        { query: 'select "id", "name", "price_cents", "category", "description', calls: "14342", mean_ms: "0.04", max_ms: "0.66" },
        { query: 'select "on_hand" from "stock_levels" where "stock_levels"."p', calls: "11850", mean_ms: "0.03", max_ms: "1.08" },
        { query: 'select "id", "name", "price_cents", "category", "description', calls: "4059", mean_ms: "0.05", max_ms: "0.32" },
        { query: 'select "id", "name", "price_cents", "category", "description', calls: "2331", mean_ms: "0.03", max_ms: "0.68" },
        { query: 'select "amount_cents" from "product_prices" where "product_p', calls: "338", mean_ms: "0.04", max_ms: "0.40" },
      ],
    },
  },
  files: priceGapFiles,
  commits: [
    {
      sha: "96eb094",
      author: "sebastian",
      message: "feat: add new arrivals to the catalog",
      files: ["src/app/(store)/page.tsx", "src/lib/catalog.ts"],
      committedAt: minutesBefore(now, 10.1),
    },
    {
      sha: "c743017",
      author: "sebastian",
      message: "feat: serve list prices from the price list",
      files: [
        "drizzle/0004_product_prices.sql",
        "drizzle/meta/0004_snapshot.json",
        "drizzle/meta/_journal.json",
        "src/app/(store)/cart/page.tsx",
        "src/app/(store)/products/[id]/page.tsx",
        "src/app/api/products/[id]/route.ts",
        "src/db/schema.ts",
        "src/db/seed.ts",
        "src/lib/flags.ts",
        "src/lib/prices.ts",
      ],
      committedAt: minutesBefore(now, 10.15),
    },
    ...commonCommits(now),
  ],
  deploys: [
    {
      service: "shopfront",
      sha: "config:FF_LIST_PRICES",
      kind: "config",
      message: "ops: FF_LIST_PRICES turned on",
      deployedAt: flagOnAt,
    },
    { service: "shopfront", sha: "96eb094", deployedAt: minutesBefore(now, 8) },
    { service: "shopfront", sha: "7d02e11", deployedAt: minutesBefore(now, 60 * 21) },
  ],
  // Recorded after the flag went off: no 5xx from the next request on.
  recovery: [0, 0, 0, 0, 0, 0].map((value, i) => ({ t: minutesBefore(now, -i), value })),
  expected: {
    verdict: "root_cause",
    rootCauseFiles: ["src/lib/prices.ts"],
    mustMention: [
      ["product_prices", "productPrices"],
      ["stock", "join"],
      ["missing", "no row", "no price row", "no matching row", "absent", "without a", "does not exist", "doesn't exist", "not exist"],
    ],
    mitigation: { kind: "flag_off", target: "FF_LIST_PRICES" },
  },
};
