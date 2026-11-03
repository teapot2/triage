import type { MetricPoint } from "../schema";
import { slowQueriesNote, type LogGroup, type MetricSeries, type SpanRecord } from "../source";
import { badDeployFiles } from "./bad-deploy-files";
import { minutesBefore, type Scenario } from "./scenario-source";
import { commonCommits, services } from "./shopfront-base";

// Shopfront's bad code deploy, recorded live on 2026-11-02: release 0dfdbac
// ("return a formatted price from the product API") was deployed at
// 06:27:57.8Z and the Server errors rule opened its incident 18 s later. The
// release adds formatPrice (src/lib/money.ts), which builds an
// Intl.NumberFormat in currency style with the currency from STORE_CURRENCY,
// and the product API returns `price: formatPrice(priceCents)`. STORE_CURRENCY
// is unset on the store, so every GET /api/products/[id] throws "TypeError:
// Currency code is required with currency style." and answers 500. The
// product list, latency and the pool stay where they were. Rolling the
// release back cleared the errors from the next minute.
//
// Unlike the other recordings, the traffic was the API-only profile ("Mobile
// app", 1 to 1.5 req/s): only GET /api/products/[id] and GET /api/products
// carry requests, there are no page requests, and the dev server's p95 on
// these routes is tens of milliseconds. Values below are what Triage's live
// source reported at the alert (the collector files of that run); the quiet
// recording before the deploy is 8 minutes, so each baseline repeats those
// minutes back to the start of the window, and steady log counts are scaled
// to it. The FF_LIST_PRICES flips 38 minutes earlier are as recorded, a
// config change that is not the cause.

const now = "2026-11-02T06:28:15.734Z";
const deployedAt = "2026-11-02T06:27:57.790Z";
const window = 45;

const release = {
  sha: "0dfdbac",
  branch: "shopfront-release/formatted-price",
  message: "feat(shopfront): return a formatted price from the product API",
  files: ["src/app/api/products/[id]/route.ts", "src/lib/money.ts"],
};

// Per-minute points like the live source's: one per minute bucket, the last
// being the bucket `now` is in. `baseline` holds the recorded minutes before
// the deploy, oldest first; it repeats back to the start of the window.
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

const typeError = "Currency code is required with currency style.";
const productsQuery =
  'select "id", "name", "price_cents", "category", "description", "rating_tenths", "review_count", "art", "tint", "created…';
const ratingsQuery =
  'select "id", "rating_tenths", "review_count" from "products" where "products"."id" in ($1, $2, $3, $4, $5, $6, $7, $8, …';
const stockQuery = 'select "on_hand" from "stock_levels" where "stock_levels"."product_id" = $1 limit $2';
const pg = { "db.system.name": "postgresql", "db.namespace": "shopfront" };

// The live source groups request logs by their template, so each product
// path is its own group; the 200s are the steady traffic, scaled to the
// window, and the 500s are the requests since the deploy.
const requestLog = (
  level: LogGroup["level"],
  id: number,
  status: number,
  count: number,
  firstSeen: string,
  lastSeen: string,
  traceId: string,
): LogGroup => ({
  service: "shopfront",
  level,
  message: `GET /api/products/[id] ${status} {"http.request.method":"GET","http.route":"/api/products/[id]","http.response.status_code":<n>,"url.path":"/api/products/${id}","duration_ms":<n>}`,
  count,
  firstSeen,
  lastSeen,
  traceId,
});
const ok = (id: number, count: number, lastSeen: string, traceId: string) =>
  requestLog("info", id, 200, count, minutesBefore(now, window), `2026-11-02T${lastSeen}Z`, traceId);
// What the route handler logs when it throws, then the 500 it answered.
const failed = (id: number, count: number, firstSeen: string, lastSeen: string, traceId: string): LogGroup[] => [
  {
    service: "shopfront",
    level: "error",
    message: `request failed {"http.request.method":"GET","url.path":"/api/products/${id}","http.route":"/api/products/[id]","next.route_type":"route","error.type":"TypeError","error.message":"${typeError}"}`,
    count,
    firstSeen: `2026-11-02T${firstSeen}Z`,
    lastSeen: `2026-11-02T${lastSeen}Z`,
    traceId,
  },
  requestLog("error", id, 500, count, `2026-11-02T${firstSeen}Z`, `2026-11-02T${lastSeen}Z`, traceId),
];

const product = (
  traceId: string,
  id: number,
  startedAt: string,
  durationMs: number,
  wait: number,
  error: boolean,
): SpanRecord => ({
  traceId,
  service: "shopfront",
  name: "GET /api/products/[id]",
  route: "/api/products/[id]",
  startedAt: `2026-11-02T${startedAt}Z`,
  durationMs,
  status: error ? "error" : "ok",
  attributes: {
    "http.response.status_code": error ? 500 : 200,
    "url.path": `/api/products/${id}`,
    "db.client.connection.wait_time_ms": wait,
    "db.queries": 2,
    ...(error ? { "error.type": "TypeError", "exception.message": typeError } : {}),
  },
});
const listing = (traceId: string, startedAt: string, durationMs: number, wait: number): SpanRecord => ({
  traceId,
  service: "shopfront",
  name: "GET /api/products",
  route: "/api/products",
  startedAt: `2026-11-02T${startedAt}Z`,
  durationMs,
  status: "ok",
  attributes: { "http.response.status_code": 200, "url.path": "/api/products", "db.client.connection.wait_time_ms": wait, "db.queries": 2 },
});
const query = (traceId: string, name: string, startedAt: string, durationMs: number): SpanRecord => ({
  traceId,
  service: "postgres",
  name,
  startedAt: `2026-11-02T${startedAt}Z`,
  durationMs,
  status: "ok",
  attributes: pg,
});

export const badDeploy: Scenario = {
  id: "bad-deploy",
  label: "Bad deploy (formatted price)",
  description: "500s on the product API right after a code deploy",
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
    errors("/api/products/[id]", 1),
    errors("/api/products", 0),
    p95("/api/products/[id]", [496, 86.67, 362.05, 211.52, 258.9, 55.69, 49.87, 45.1], 68.23),
    p95("/api/products", [378.44, 53.23, 127.96, 638.94, 121.03, 99.02, 136.05, 76.31], 120.29),
    route("http.server.request.rate", "req/s", "Requests per second across all routes", recorded([1.55, 1.55, 2, 1.57, 1.42, 1.22, 0.93, 0.6], 0.83)),
    route("http.server.error_ratio", "ratio", "Share of responses with status >= 500", recorded([0], 0.62)),
    route(
      "db.client.connection.count{state=used}",
      "connections",
      "pg pool connections in this state (pool max 10)",
      recorded([1, 1, 1, 1, 1, 1, 0, 1], 1),
    ),
    route(
      "db.client.connection.count{state=idle}",
      "connections",
      "pg pool connections in this state (pool max 10)",
      recorded([0, 0, 4, 0, 0, 0, 1, 0], 1),
    ),
    route("db.client.connection.max", "connections", "pg pool size limit", recorded([10], 10)),
    route("nodejs.eventloop.utilization", "ratio", "Event loop utilization", recorded([0.08, 0.11, 0.17, 0.11, 0.11, 0.09, 0.11, 0.08], 0.1)),
    route(
      "db.client.connection.pending_requests",
      "requests",
      "Requests waiting for a pg pool connection (peak per minute)",
      recorded([5, 1, 4, 7, 5, 2, 2, 1], 0),
    ),
  ],
  logs: [
    {
      service: "shopfront",
      level: "info",
      message:
        'GET /api/products 200 {"http.request.method":"GET","http.route":"/api/products","http.response.status_code":<n>,"url.path":"/api/products","duration_ms":<n>}',
      count: 1133,
      firstSeen: minutesBefore(now, window),
      lastSeen: "2026-11-02T06:28:15.672Z",
      traceId: "d5eb3db95ec02188fc6de282039b2526",
    },
    {
      service: "shopfront",
      level: "info",
      message: 'stock row missing, returning default {"product.id":<n>}',
      count: 332,
      firstSeen: minutesBefore(now, window),
      lastSeen: "2026-11-02T06:28:02.382Z",
      traceId: "72ed73f75986102d038e84753a1030de",
    },
    ok(1, 294, "06:27:52.126", "357523dd74983530c6b82132e3357525"),
    ok(6, 251, "06:27:16.063", "fe44576e9a25bdbbbc340d3f237d73fd"),
    ok(3, 218, "06:27:53.087", "f3757b7ada16c1e577b8a126a02fb7fd"),
    ok(10, 180, "06:27:04.145", "7e55138f7153de4582f70b1fd992246f"),
    ok(8, 169, "06:27:11.551", "778342d34001cbf48652d3841c76fe2a"),
    ok(7, 153, "06:26:52.946", "aa6a41691646ddfd4079ca3527496805"),
    ok(4, 153, "06:27:55.033", "3c9bff257fca8d40bc832f0bc8ed26d7"),
    ok(2, 142, "06:27:26.368", "efc3c0cdf7ba011321b8314b32e84616"),
    ok(12, 120, "06:27:32.574", "18618a59fbdf68c85fe19af6dd19e28d"),
    ok(5, 104, "06:27:00.211", "df523d89c1717c961631ee983c9efff0"),
    ok(11, 87, "06:25:59.139", "c260e06186a02d67a54d6a3af918dbb8"),
    ok(9, 87, "06:26:51.405", "c0f884195296f524fb281922c0b30430"),
    ok(62, 76, "06:26:54.039", "b8ff32dfaed9e43626ae08e2089dbf63"),
    ok(63, 54, "06:27:38.489", "382f00c8a198c23ec9d4f0c1723658ae"),
    ok(61, 54, "06:27:28.479", "c961ebb0a9cedfb5efbf3a2269128f39"),
    {
      service: "shopfront",
      level: "info",
      message: 'stock: low-stock sweep done {"stock.low_count":<n>,"duration_ms":<n>}',
      count: 22,
      firstSeen: minutesBefore(now, 43.4),
      lastSeen: "2026-11-02T06:26:56.152Z",
    },
    // The exception the route handler throws, counted once per request.
    {
      service: "shopfront",
      level: "error",
      message: `TypeError: ${typeError}`,
      count: 9,
      firstSeen: "2026-11-02T06:27:59.454Z",
      lastSeen: "2026-11-02T06:28:15.112Z",
      traceId: "88bc9ad8eb7fdc712f08b6174bae27af",
    },
    ...failed(1, 2, "06:27:59.459", "06:28:11.777", "ea160440c5872daac6176156cf93b9a1"),
    ...failed(7, 1, "06:28:00.694", "06:28:00.694", "2fc132ebfc18bb32283831573341914d"),
    ...failed(9, 1, "06:28:02.385", "06:28:02.385", "72ed73f75986102d038e84753a1030de"),
    ...failed(2, 1, "06:28:07.192", "06:28:07.192", "e87668ea40ff1e422245bf73fff5df40"),
    ...failed(8, 1, "06:28:12.247", "06:28:12.248", "85f5a20b8778a27567630d3499dca36c"),
    ...failed(6, 1, "06:28:13.717", "06:28:13.717", "64771a1f838796fd7251f59d9aeb2967"),
    ...failed(11, 1, "06:28:14.863", "06:28:14.864", "ee51a1a837d1d66c5b7aec790f4ee41a"),
    ...failed(12, 1, "06:28:15.113", "06:28:15.114", "88bc9ad8eb7fdc712f08b6174bae27af"),
    {
      service: "shopfront",
      level: "warn",
      message: `deploy: ${release.sha} ${release.message} {"deploy.sha":"${release.sha}","deploy.message":"${release.message}","deploy.kind":"deploy","deploy.branch":"${release.branch}"}`,
      count: 1,
      firstSeen: deployedAt,
      lastSeen: deployedAt,
      traceId: "39ed3719f943adba82457281b35bc3b4",
    },
    {
      service: "shopfront",
      level: "warn",
      message: 'ops: FF_LIST_PRICES turned on {"flag.name":"FF_LIST_PRICES"}',
      count: 1,
      firstSeen: "2026-11-02T05:50:14.113Z",
      lastSeen: "2026-11-02T05:50:14.113Z",
    },
    {
      service: "shopfront",
      level: "warn",
      message: 'ops: FF_LIST_PRICES turned off {"flag.name":"FF_LIST_PRICES"}',
      count: 1,
      firstSeen: "2026-11-02T05:50:14.237Z",
      lastSeen: "2026-11-02T05:50:14.237Z",
    },
  ],
  spans: [
    // Since the deploy: the product is read, its stock is read, then the
    // handler throws formatting the price.
    product("4235c3620e681340581f2d27ad06a2d8", 1, "06:27:59.383", 76.4, 0.6, true),
    query("4235c3620e681340581f2d27ad06a2d8", productsQuery, "06:27:59.409", 23.48),
    query("4235c3620e681340581f2d27ad06a2d8", stockQuery, "06:27:59.433", 21.36),
    product("88bc9ad8eb7fdc712f08b6174bae27af", 12, "06:28:15.046", 68.2, 0.6, true),
    query("88bc9ad8eb7fdc712f08b6174bae27af", productsQuery, "06:28:15.092", 12.24),
    query("88bc9ad8eb7fdc712f08b6174bae27af", stockQuery, "06:28:15.104", 7.33),
    product("72ed73f75986102d038e84753a1030de", 9, "06:28:02.345", 39.1, 0.6, true),
    product("64771a1f838796fd7251f59d9aeb2967", 6, "06:28:13.680", 37.3, 0.4, true),
    product("e87668ea40ff1e422245bf73fff5df40", 2, "06:28:07.166", 26.6, 0.5, true),
    // Before it: the same route and queries, answering 200.
    product("357523dd74983530c6b82132e3357525", 1, "06:27:52.081", 45.1, 0.6, false),
    query("357523dd74983530c6b82132e3357525", productsQuery, "06:27:52.115", 5),
    query("357523dd74983530c6b82132e3357525", stockQuery, "06:27:52.121", 4.05),
    product("800cf86d9ab1f063b89a70bb0687cfd0", 3, "06:27:48.308", 31.2, 0.6, false),
    product("3c9bff257fca8d40bc832f0bc8ed26d7", 4, "06:27:55.008", 25.9, 0.6, false),
    // The product list, untouched by the release, before and after it.
    listing("1e0cedb7ba3f4c3946224554c596c6a4", "06:27:52.395", 76.3, 0.5),
    query("1e0cedb7ba3f4c3946224554c596c6a4", productsQuery, "06:27:52.401", 5.51),
    query("1e0cedb7ba3f4c3946224554c596c6a4", ratingsQuery, "06:27:52.408", 61.28),
    listing("90f0e4e328256b97fb2156b7afc88439", "06:27:57.221", 20.8, 0.5),
    listing("d5eb3db95ec02188fc6de282039b2526", "06:28:15.552", 120.3, 2),
  ],
  db: {
    activity: {
      query:
        "SELECT pid, application_name, state, to_char(now() - state_change, 'HH24:MI:SS') AS in_state_for, left(query, 60) AS last_query FROM pg_stat_activity WHERE datname = 'shopfront' AND pid <> pg_backend_pid() AND application_name NOT IN ('triage', 'triage-sandbox') ORDER BY state_change",
      rows: [
        { pid: 78593, application_name: "", state: "idle", in_state_for: "00:00:01", last_query: 'select "id", "rating_tenths", "review_count" from "products"' },
      ],
    },
    locks: {
      query:
        "SELECT pid, pg_blocking_pids(pid)::text AS blocked_by, left(query, 60) AS query FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0",
      rows: [],
    },
    slow_queries: {
      query:
        "SELECT left(query, 60) AS query, calls, round(mean_exec_time::numeric, 2) AS mean_ms, round(max_exec_time::numeric, 2) AS max_ms FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) AND query NOT LIKE '%/* triage */%' AND query NOT LIKE '%pg_stat_statements%' AND query NOT ILIKE 'CREATE DATABASE%' AND query NOT ILIKE 'DROP DATABASE%' AND calls >= 10 ORDER BY total_exec_time DESC LIMIT 5",
      rows: [
        { query: 'select "on_hand" from "stock_levels" where "stock_levels"."p', calls: "30707", mean_ms: "0.03", max_ms: "0.66", window_calls: 1900, window_ms: 57 },
        { query: 'select "id", "name", "price_cents", "category", "description', calls: "22765", mean_ms: "0.03", max_ms: "0.89", window_calls: 1400, window_ms: 42 },
        { query: 'select "id", "name", "price_cents", "category", "description', calls: "31121", mean_ms: "0.02", max_ms: "0.61", window_calls: 1900, window_ms: 38 },
        { query: 'select "id", "name", "price_cents", "category", "description', calls: "9929", mean_ms: "0.05", max_ms: "0.68", window_calls: 600, window_ms: 30 },
      ],
      note: slowQueriesNote(now, 15),
    },
  },
  files: badDeployFiles,
  commits: [
    {
      sha: release.sha,
      author: "teapot2",
      message: release.message,
      files: release.files,
      committedAt: "2026-11-02T05:47:51.000Z",
    },
    ...commonCommits(now),
  ],
  deploys: [
    {
      service: "shopfront",
      sha: release.sha,
      kind: "deploy",
      message: release.message,
      branch: release.branch,
      deployedAt,
    },
    {
      service: "shopfront",
      sha: "config:FF_LIST_PRICES",
      kind: "config",
      message: "ops: FF_LIST_PRICES turned off",
      deployedAt: "2026-11-02T05:50:14.237Z",
    },
    {
      service: "shopfront",
      sha: "config:FF_LIST_PRICES",
      kind: "config",
      message: "ops: FF_LIST_PRICES turned on",
      deployedAt: "2026-11-02T05:50:14.113Z",
    },
    { service: "shopfront", sha: "7d02e11", deployedAt: minutesBefore(now, 60 * 21) },
  ],
  // Recorded after the rollback: no 5xx from the next minute on.
  recovery: [0, 0, 0, 0, 0, 0].map((value, i) => ({ t: minutesBefore(now, -i), value })),
  expected: {
    verdict: "root_cause",
    rootCauseFiles: ["src/app/api/products/[id]/route.ts", "src/lib/money.ts"],
    mustMention: [
      ["currency"],
      ["Intl", "NumberFormat", "formatPrice", "format"],
      ["deploy", "release", "commit"],
    ],
    mitigation: { kind: "rollback", target: release.sha },
  },
};
