import { minutesBefore, minuteSeries, type Scenario } from "./scenario-source";
import { commonCommits, commonFiles, services, stockLeaky } from "./shopfront-base";

// Shopfront's planted connection leak (FF_STOCK_DIRECT_QUERY): a deploy 16
// minutes before the alert added getStockLevel, which leaks a pooled
// connection whenever the stock row is missing. The
// pool (max 10) saturates 5 minutes before the alert and every DB-backed
// route starts timing out after connectionTimeoutMillis (3 s).

const now = "2026-10-23T02:14:00.000Z";
const deployedMinutesAgo = 16;
const saturatedMinutesAgo = 5;
const window = 45;

const latencyRamp = [2950, 2890, 2410, 1650, 820, 310, 140];
const detailP95 = (m: number, w: number) => (m > 6 ? 118 + w * 6 : latencyRamp[m] + w * 20);
const listP95 = (m: number, w: number) => (m > saturatedMinutesAgo - 1 ? 42 + w * 4 : 2990 + w * 10);
const poolUsed = (m: number, w: number) =>
  m >= deployedMinutesAgo ? 1.5 + w * 0.5 : Math.min(10, 1 + (deployedMinutesAgo - m) * 0.85);
const pending = (m: number) => (m >= saturatedMinutesAgo ? 0 : (saturatedMinutesAgo - m) * 3);
const errorRate = (m: number) => (m >= saturatedMinutesAgo ? 0 : Math.min(0.62, (saturatedMinutesAgo - m) * 0.14));

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

export const poolLeak: Scenario = {
  id: "pool-leak",
  label: "Connection pool leak",
  description: "p95 latency and 500s on the product page after a deploy",
  now,
  alert: {
    title: "p95 latency above 500 ms on GET /api/products/[id]",
    service: "shopfront",
    severity: "sev2",
    metric: "http.server.request.duration.p95{route=/api/products/[id]}",
    threshold: 500,
  },
  services,
  metrics: [
    {
      name: "http.server.request.duration.p95{route=/api/products/[id]}",
      service: "shopfront",
      unit: "ms",
      description: "p95 latency of the product detail route",
      points: minuteSeries(now, window, detailP95),
    },
    {
      name: "http.server.request.duration.p95{route=/api/products}",
      service: "shopfront",
      unit: "ms",
      description: "p95 latency of the product list route",
      points: minuteSeries(now, window, listP95),
    },
    {
      name: "http.server.request.rate",
      service: "shopfront",
      unit: "req/s",
      description: "Requests per second across all routes",
      points: minuteSeries(now, window, (_, w) => 14 + w * 0.6),
    },
    {
      name: "http.server.error_ratio",
      service: "shopfront",
      unit: "ratio",
      description: "Share of responses with status >= 500",
      points: minuteSeries(now, window, errorRate),
    },
    {
      name: "db.client.connection.count{state=used}",
      service: "shopfront",
      unit: "connections",
      description: "pg pool connections checked out (pool max 10)",
      points: minuteSeries(now, window, poolUsed),
    },
    {
      name: "db.client.connection.pending_requests",
      service: "shopfront",
      unit: "requests",
      description: "Requests waiting for a pg pool connection",
      points: minuteSeries(now, window, pending),
    },
    {
      name: "postgresql.backends{state=active}",
      service: "postgres",
      unit: "connections",
      description: "Backends currently executing a query",
      points: minuteSeries(now, window, (_, w) => 1 + Math.abs(w) * 0.6),
    },
    {
      name: "postgresql.cpu.utilization",
      service: "postgres",
      unit: "%",
      description: "Postgres CPU utilization",
      points: minuteSeries(now, window, (_, w) => 6 + w * 1.5),
    },
  ],
  logs: [
    {
      service: "shopfront",
      level: "info",
      message: 'fetched product {"product.id":<id>,"product.found":true}',
      count: 9120,
      firstSeen: minutesBefore(now, window),
      lastSeen: now,
    },
    {
      service: "shopfront",
      level: "info",
      message: 'listed products {"products.count":50}',
      count: 610,
      firstSeen: minutesBefore(now, window),
      lastSeen: minutesBefore(now, 5),
    },
    {
      service: "shopfront",
      level: "info",
      message: 'stock row missing, returning default {"product.id":<id>}',
      count: 418,
      firstSeen: minutesBefore(now, deployedMinutesAgo - 0.5),
      lastSeen: minutesBefore(now, saturatedMinutesAgo),
    },
    {
      service: "shopfront",
      level: "warn",
      message: 'slow request {"http.route":"/api/products/[id]","duration_ms":<n>}',
      count: 388,
      firstSeen: minutesBefore(now, 6),
      lastSeen: now,
    },
    {
      service: "shopfront",
      level: "error",
      message: "Error: timeout exceeded when trying to connect",
      count: 412,
      firstSeen: minutesBefore(now, saturatedMinutesAgo - 0.2),
      lastSeen: now,
      traceId,
    },
    {
      service: "shopfront",
      level: "error",
      message: 'GET /api/products failed {"http.response.status_code":500}',
      count: 37,
      firstSeen: minutesBefore(now, 4),
      lastSeen: now,
    },
    {
      service: "postgres",
      level: "info",
      message: "checkpoint complete: wrote 112 buffers (0.7%)",
      count: 3,
      firstSeen: minutesBefore(now, 40),
      lastSeen: minutesBefore(now, 10),
    },
  ],
  spans: [
    {
      traceId,
      service: "shopfront",
      name: "GET /api/products/[id]",
      route: "/api/products/[id]",
      startedAt: minutesBefore(now, 0.3),
      durationMs: 3004,
      status: "error",
      attributes: {
        "http.response.status_code": 500,
        "product.id": 231,
        "db.client.connection.wait_time_ms": 3000,
        "error.type": "Error",
        "exception.message": "timeout exceeded when trying to connect",
      },
    },
    {
      traceId: "9c1d07a2e4b44f0e8d6f1b3a2c5e7d90",
      service: "shopfront",
      name: "GET /api/products",
      route: "/api/products",
      startedAt: minutesBefore(now, 1.2),
      durationMs: 3001,
      status: "error",
      attributes: {
        "http.response.status_code": 500,
        "db.client.connection.wait_time_ms": 3000,
        "exception.message": "timeout exceeded when trying to connect",
      },
    },
    {
      traceId: "51aa3c7e0b2f4d6c9e8a7b6c5d4e3f21",
      service: "shopfront",
      name: "GET /api/products/[id]",
      route: "/api/products/[id]",
      startedAt: minutesBefore(now, 6.5),
      durationMs: 1650,
      status: "ok",
      attributes: {
        "http.response.status_code": 200,
        "product.id": 88,
        "db.client.connection.wait_time_ms": 1608,
      },
    },
    {
      traceId: "51aa3c7e0b2f4d6c9e8a7b6c5d4e3f21",
      service: "postgres",
      name: "SELECT on_hand FROM stock_levels WHERE product_id = $1",
      startedAt: minutesBefore(now, 6.5),
      durationMs: 0.6,
      status: "ok",
      attributes: { "db.system.name": "postgresql", "db.response.returned_rows": 0 },
    },
    {
      traceId: "0f3e2d1c4b5a69788796a5b4c3d2e1f0",
      service: "shopfront",
      name: "GET /api/products/[id]",
      route: "/api/products/[id]",
      startedAt: minutesBefore(now, 30),
      durationMs: 38,
      status: "ok",
      attributes: {
        "http.response.status_code": 200,
        "product.id": 12,
        "db.client.connection.wait_time_ms": 0.2,
      },
    },
  ],
  db: {
    activity: {
      query:
        "SELECT pid, application_name, state, now() - state_change AS in_state_for, left(query, 60) AS last_query FROM pg_stat_activity WHERE datname = 'shopfront' ORDER BY state_change",
      rows: [
        { pid: 48211, application_name: "shopfront", state: "idle", in_state_for: "00:15:12", last_query: "SELECT on_hand FROM stock_levels WHERE product_id = $1" },
        { pid: 48214, application_name: "shopfront", state: "idle", in_state_for: "00:13:40", last_query: "SELECT on_hand FROM stock_levels WHERE product_id = $1" },
        { pid: 48219, application_name: "shopfront", state: "idle", in_state_for: "00:12:05", last_query: "SELECT on_hand FROM stock_levels WHERE product_id = $1" },
        { pid: 48230, application_name: "shopfront", state: "idle", in_state_for: "00:10:31", last_query: "SELECT on_hand FROM stock_levels WHERE product_id = $1" },
        { pid: 48236, application_name: "shopfront", state: "idle", in_state_for: "00:09:20", last_query: "SELECT on_hand FROM stock_levels WHERE product_id = $1" },
        { pid: 48241, application_name: "shopfront", state: "idle", in_state_for: "00:08:02", last_query: "SELECT on_hand FROM stock_levels WHERE product_id = $1" },
        { pid: 48244, application_name: "shopfront", state: "idle", in_state_for: "00:07:15", last_query: "SELECT on_hand FROM stock_levels WHERE product_id = $1" },
        { pid: 48250, application_name: "shopfront", state: "idle", in_state_for: "00:06:41", last_query: "SELECT on_hand FROM stock_levels WHERE product_id = $1" },
        { pid: 48253, application_name: "shopfront", state: "idle", in_state_for: "00:05:58", last_query: "SELECT on_hand FROM stock_levels WHERE product_id = $1" },
        { pid: 48257, application_name: "shopfront", state: "idle", in_state_for: "00:05:10", last_query: "SELECT on_hand FROM stock_levels WHERE product_id = $1" },
        { pid: 48302, application_name: "psql", state: "active", in_state_for: "00:00:00", last_query: "SELECT pid, application_name, state, now() - state_change" },
      ],
    },
    locks: {
      query:
        "SELECT pid, pg_blocking_pids(pid) AS blocked_by, left(query, 60) AS query FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0",
      rows: [],
    },
    slow_queries: {
      query:
        "SELECT left(query, 60) AS query, calls, round(mean_exec_time::numeric, 2) AS mean_ms, round(max_exec_time::numeric, 2) AS max_ms FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 5",
      rows: [
        { query: 'select "id", "name", "price_cents", "created_at" from "products" w', calls: 9204, mean_ms: 0.38, max_ms: 4.1 },
        { query: "SELECT on_hand FROM stock_levels WHERE product_id = $1", calls: 9120, mean_ms: 0.41, max_ms: 3.7 },
        { query: 'select "id", "name", "price_cents", "created_at" from "products" l', calls: 610, mean_ms: 0.9, max_ms: 6.2 },
        { query: "SELECT 1", calls: 1810, mean_ms: 0.02, max_ms: 0.3 },
      ],
    },
  },
  files: { ...commonFiles, "src/lib/stock.ts": stockLeaky },
  commits: [
    {
      sha: "a1b9c4e",
      author: "sebastian",
      message: "feat: show stock level on product page",
      files: ["src/lib/stock.ts", "src/db/schema.ts", "src/app/api/products/[id]/route.ts"],
      committedAt: minutesBefore(now, 23),
    },
    ...commonCommits(now),
  ],
  deploys: [
    {
      service: "shopfront",
      sha: "config:FF_STOCK_DIRECT_QUERY",
      kind: "config",
      message: "ops: FF_STOCK_DIRECT_QUERY turned on",
      // Right after the deploy, before the first missing-row log at 15.5 min.
      deployedAt: minutesBefore(now, deployedMinutesAgo - 0.25),
    },
    { service: "shopfront", sha: "a1b9c4e", deployedAt: minutesBefore(now, deployedMinutesAgo) },
    { service: "shopfront", sha: "7d02e11", deployedAt: minutesBefore(now, 60 * 21) },
  ],
  // The flag off and held connections recycled: the queue drains in minutes.
  recovery: [2910, 1480, 520, 210, 140, 121].map((value, i) => ({ t: minutesBefore(now, -i), value })),
};
