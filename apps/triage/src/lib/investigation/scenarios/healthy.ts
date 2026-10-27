import { minutesBefore, minuteSeries, type Scenario } from "./scenario-source";
import { commonCommits, commonFiles, services, stockFixed } from "./shopfront-base";

// Control run: nothing is wrong. The agent must say so instead of
// inventing a cause.

const now = "2026-10-23T09:30:00.000Z";
const window = 45;

export const healthy: Scenario = {
  id: "healthy",
  label: "Control run (healthy)",
  description: "Manual check with every signal at baseline",
  now,
  alert: {
    title: "Control run: product page latency check",
    service: "shopfront",
    severity: "sev3",
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
      points: minuteSeries(now, window, (_, w) => 121 + w * 6),
    },
    {
      name: "http.server.request.duration.p95{route=/api/products}",
      service: "shopfront",
      unit: "ms",
      description: "p95 latency of the product list route",
      points: minuteSeries(now, window, (_, w) => 44 + w * 4),
    },
    {
      name: "http.server.request.rate",
      service: "shopfront",
      unit: "req/s",
      description: "Requests per second across all routes",
      points: minuteSeries(now, window, (_, w) => 16 + w * 0.8),
    },
    {
      name: "http.server.error_ratio",
      service: "shopfront",
      unit: "ratio",
      description: "Share of responses with status >= 500",
      points: minuteSeries(now, window, () => 0),
    },
    {
      name: "db.client.connection.count{state=used}",
      service: "shopfront",
      unit: "connections",
      description: "pg pool connections checked out (pool max 10)",
      points: minuteSeries(now, window, (_, w) => 1.8 + w * 0.7),
    },
    {
      name: "db.client.connection.pending_requests",
      service: "shopfront",
      unit: "requests",
      description: "Requests waiting for a pg pool connection",
      points: minuteSeries(now, window, () => 0),
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
      points: minuteSeries(now, window, (_, w) => 7 + w * 1.5),
    },
  ],
  logs: [
    {
      service: "shopfront",
      level: "info",
      message: 'fetched product {"product.id":<id>,"product.found":true}',
      count: 10480,
      firstSeen: minutesBefore(now, window),
      lastSeen: now,
    },
    {
      service: "shopfront",
      level: "info",
      message: 'stock row missing, returning default {"product.id":<id>}',
      count: 431,
      firstSeen: minutesBefore(now, window),
      lastSeen: now,
    },
    {
      service: "shopfront",
      level: "info",
      message: 'listed products {"products.count":50}',
      count: 702,
      firstSeen: minutesBefore(now, window),
      lastSeen: now,
    },
    {
      service: "postgres",
      level: "info",
      message: "checkpoint complete: wrote 98 buffers (0.6%)",
      count: 3,
      firstSeen: minutesBefore(now, 40),
      lastSeen: minutesBefore(now, 8),
    },
  ],
  spans: [
    {
      traceId: "7e6d5c4b3a2918070605040302010f0e",
      service: "shopfront",
      name: "GET /api/products/[id]",
      route: "/api/products/[id]",
      startedAt: minutesBefore(now, 2),
      durationMs: 41,
      status: "ok",
      attributes: { "http.response.status_code": 200, "product.id": 77, "db.client.connection.wait_time_ms": 0.3 },
    },
    {
      traceId: "1a2b3c4d5e6f708192a3b4c5d6e7f809",
      service: "shopfront",
      name: "GET /api/products",
      route: "/api/products",
      startedAt: minutesBefore(now, 3),
      durationMs: 44,
      status: "ok",
      attributes: { "http.response.status_code": 200, "db.client.connection.wait_time_ms": 0.2 },
    },
  ],
  db: {
    activity: {
      query:
        "SELECT pid, application_name, state, now() - state_change AS in_state_for, left(query, 60) AS last_query FROM pg_stat_activity WHERE datname = 'shopfront' ORDER BY state_change",
      rows: [
        { pid: 51002, application_name: "shopfront", state: "idle", in_state_for: "00:00:01", last_query: "SELECT on_hand FROM stock_levels WHERE product_id = $1" },
        { pid: 51007, application_name: "shopfront", state: "idle", in_state_for: "00:00:00", last_query: 'select "id", "name", "price_cents", "created_at" from' },
        { pid: 51120, application_name: "psql", state: "active", in_state_for: "00:00:00", last_query: "SELECT pid, application_name, state, now() - state_change" },
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
        { query: 'select "id", "name", "price_cents", "created_at" from "products" w', calls: 10512, mean_ms: 0.37, max_ms: 3.9 },
        { query: "SELECT on_hand FROM stock_levels WHERE product_id = $1", calls: 10480, mean_ms: 0.4, max_ms: 3.2 },
      ],
    },
  },
  files: { ...commonFiles, "src/lib/stock.ts": stockFixed },
  commits: [
    {
      sha: "e4f1a07",
      author: "sebastian",
      message: "fix: release pooled client on every getStockLevel path",
      files: ["src/lib/stock.ts", "src/lib/stock.test.ts"],
      committedAt: minutesBefore(now, 60 * 6),
    },
    ...commonCommits(now),
  ],
  deploys: [{ service: "shopfront", sha: "e4f1a07", deployedAt: minutesBefore(now, 60 * 6 - 5) }],
};
