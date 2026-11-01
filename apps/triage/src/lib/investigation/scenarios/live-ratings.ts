import type { MetricPoint } from "../schema";
import type { MetricSeries } from "../source";
import { liveRatingsFiles } from "./live-ratings-files";
import { minutesBefore, type Scenario } from "./scenario-source";
import { services } from "./shopfront-base";

// Shopfront's live ratings (FF_LIVE_RATINGS), recorded live on 2026-11-01
// under the Normal day traffic profile (~2 req/s): the flag went on at
// 04:56:59.8Z and the API latency rule opened its incident 17 s later.
// getListingRatings loops over the listed products and, for each one,
// fetches every review row (50,000 a product) and averages them in
// JavaScript: 16 queries per GET /api/products instead of 2, three quarters
// of a million rows, about a second a listing. Nothing fails, the pool stays
// at 1 or 2 of 10. The flag had also been on for 8 s at 04:37 (the latency
// spike in that minute) while the store was being measured.
//
// Values below are what Triage's live source reported at the alert (the
// collector files of that run). The traces cover 04:17 on, so each series
// holds the recorded minutes from there and repeats them back to the start
// of the window. Pages run slow on this dev server whatever the flag (the
// home page's p95 is seconds), so the page series are as noisy as recorded.

const now = "2026-11-01T04:57:16.787Z";
const flagOnAt = "2026-11-01T04:56:59.785Z";
const window = 45;

// Per-minute points like the live source's: one per minute bucket, the last
// being the bucket `now` is in. `minutes` holds the recorded minutes before
// it, oldest first (04:17 to 04:56); they repeat back to the start of the
// window.
const minute = 60_000;
const bucket = Math.floor(Date.parse(now) / minute) * minute;
function recorded(minutes: number[], last: number): MetricPoint[] {
  return Array.from({ length: window }, (_, i) => {
    const minutesAgo = window - 1 - i;
    const back = minutesAgo - 1;
    const value = minutesAgo === 0 ? last : minutes[minutes.length - 1 - (back % minutes.length)];
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
const p95 = (r: string, minutes: number[], last: number) =>
  route(`http.server.request.duration.p95{route=${r}}`, "ms", `p95 latency of ${r}, per minute`, recorded(minutes, last));
const errors = (r: string) =>
  route(
    `http.server.error_ratio{route=${r}}`,
    "ratio",
    `Share of ${r} responses with status >= 500, per minute`,
    recorded([0], 0),
  );

const productsQuery =
  'select "id", "name", "price_cents", "category", "description", "rating_tenths", "review_count", "art", "tint", "created…';
const reviewsQuery = 'select "rating" from "reviews" where "reviews"."product_id" = $1';
const pg = { "db.system.name": "postgresql", "db.namespace": "shopfront" };

// The slowest listing at the alert: the products query, then one reviews
// query per product, one after the other.
const slowTrace = "1dc712c6c3f0718e8f2c602d5ed7e11a";
const reviewSpans: [string, number][] = [
  ["04:57:00.731", 28.75],
  ["04:57:00.783", 118.98],
  ["04:57:00.916", 124.14],
  ["04:57:01.057", 193.27],
  ["04:57:01.270", 112.29],
  ["04:57:01.398", 63.61],
  ["04:57:01.473", 72.91],
  ["04:57:01.567", 100.86],
  ["04:57:01.689", 69.96],
  ["04:57:01.773", 83.18],
  ["04:57:01.871", 257.29],
  ["04:57:02.145", 62.39],
  ["04:57:02.227", 53.03],
  ["04:57:02.301", 77.65],
  ["04:57:02.393", 139.39],
];

const listing = (traceId: string, startedAt: string, durationMs: number, wait: number, queries: number) => ({
  traceId,
  service: "shopfront",
  name: "GET /api/products",
  route: "/api/products",
  startedAt: `2026-11-01T${startedAt}Z`,
  durationMs,
  status: "ok" as const,
  attributes: {
    "http.response.status_code": 200,
    "url.path": "/api/products",
    "db.client.connection.wait_time_ms": wait,
    "db.queries": queries,
  },
});

export const liveRatings: Scenario = {
  id: "live-ratings",
  label: "Live ratings",
  description: "Slow product list right after a config change, with no errors",
  now,
  alert: {
    title: "p95 latency above 500 ms on GET /api/products",
    service: "shopfront",
    severity: "sev2",
    metric: "http.server.request.duration.p95{route=/api/products}",
    threshold: 500,
  },
  services,
  metrics: [
    p95(
      "/api/products",
      [
        19.7, 21.83, 20.11, 175.46, 215, 306.48, 267.72, 53.51, 22.17, 24.85, 32, 52.32, 184.68, 27.34, 230.64, 180.12, 331.5,
        241.26, 192.69, 124.32, 1484.64, 238.44, 24.39, 188.27, 396.89, 248.69, 349.61, 192.25, 203.19, 23.87, 98.58, 565.13,
        75.88, 151.29, 163.29, 215.03, 285.63, 365.59, 108.71, 34.1,
      ],
      2390.43,
    ),
    p95(
      "/api/products/[id]",
      [
        31.85, 38.31, 30.76, 103.39, 342.74, 602.57, 673.83, 262.29, 261.38, 758.7, 192.43, 44.7, 331.28, 272.85, 271.83, 329.73,
        328.41, 143.2, 71.35, 220.22, 191.97, 293.56, 214.25, 63.47, 302.03, 280.83, 601.78, 315.62, 112.63, 166.54, 34.14,
        227.82, 44.7, 169.63, 240.63, 280.43, 432.97, 248.46, 124.82, 70.34,
      ],
      189.29,
    ),
    p95(
      "/",
      [
        876.81, 2469.22, 1375.07, 2245.3, 8242.55, 10259.09, 6210.52, 1837.47, 1210.75, 2244.34, 3473.4, 2787.62, 3399.37,
        1731.13, 1909.26, 5712, 5135.6, 2714.03, 3357.51, 2377.49, 2108.77, 1466.75, 1929.33, 2380.16, 6057.93, 3050.07,
        4168.35, 1422.86, 2902.09, 1953.18, 803.51, 1440.8, 2507.58, 3355.56, 2376.41, 4770.57, 6661.65, 2579.08, 3601.56,
        6680.78,
      ],
      3301.55,
    ),
    p95(
      "/products/[id]",
      [
        1155.27, 2090.24, 610.12, 1636.1, 5267.39, 9386, 6979.4, 1549.63, 1443.89, 1321.94, 3075.32, 1846.98, 2695.96, 1341.49,
        1976.18, 4242.82, 3577.64, 2789.62, 2085.68, 1604.96, 1434.9, 1161.47, 2647.72, 1100.63, 4746.64, 2676.58, 3617.75,
        1406.35, 2175.19, 1338.34, 537.43, 1260.52, 2680.36, 1449.65, 1848.71, 4801.6, 5140.58, 2243.92, 3959.01, 1147.28,
      ],
      5069.78,
    ),
    errors("/api/products"),
    errors("/api/products/[id]"),
    errors("/"),
    errors("/products/[id]"),
    route(
      "http.server.request.rate",
      "req/s",
      "Requests per second across all routes",
      recorded(
        [
          0.48, 1.97, 1, 2.15, 2.32, 2.95, 3.02, 2.03, 1.48, 1.65, 1.87, 1.48, 2.23, 1.75, 2.53, 2.65, 2.5, 2.32, 1.88, 2.05, 1.37,
          1.25, 1.52, 1.7, 2.98, 2.93, 3.08, 2.28, 1.85, 1.42, 0.85, 1.43, 2.03, 2.1, 1.87, 3.32, 3.02, 2.53, 2.18, 1.35,
        ],
        1.91,
      ),
    ),
    route("http.server.error_ratio", "ratio", "Share of responses with status >= 500", recorded([0], 0)),
    route(
      "db.client.connection.count{state=used}",
      "connections",
      "pg pool connections in this state (pool max 10)",
      recorded(
        [
          1, 1, 1, 1, 2, 2, 2, 2, 1, 2, 1, 1, 1, 2, 1, 2, 1, 1, 1, 1, 1, 1, 2, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 2, 2, 1, 1, 1, 1,
        ],
        1,
      ),
    ),
    route(
      "db.client.connection.count{state=idle}",
      "connections",
      "pg pool connections in this state (pool max 10)",
      recorded(
        [
          1, 1, 1, 3, 1, 2, 1, 1, 2, 1, 2, 1, 1, 0, 2, 0, 3, 2, 1, 1, 1, 1, 0, 2, 2, 1, 1, 2, 1, 2, 1, 3, 2, 3, 1, 4, 2, 3, 3, 1,
        ],
        4,
      ),
    ),
    route("db.client.connection.max", "connections", "pg pool size limit", recorded([10], 10)),
    route(
      "nodejs.eventloop.utilization",
      "ratio",
      "Event loop utilization",
      recorded(
        [
          0.1, 0.65, 0.22, 0.66, 0.79, 1, 0.67, 0.49, 0.59, 0.33, 0.67, 0.4, 0.63, 0.59, 0.77, 0.84, 0.74, 0.86, 0.5, 0.43, 0.39,
          0.48, 0.36, 0.52, 0.91, 0.79, 0.81, 0.49, 0.14, 0.5, 0.17, 0.51, 0.45, 0.64, 0.51, 0.94, 0.63, 0.81, 0.35, 0.26,
        ],
        0.81,
      ),
    ),
    route(
      "db.client.connection.pending_requests",
      "requests",
      "Requests waiting for a pg pool connection (peak per minute)",
      recorded(
        [
          2, 3, 1, 3, 4, 2, 3, 4, 2, 3, 3, 2, 2, 3, 2, 5, 5, 2, 2, 4, 2, 2, 2, 2, 3, 2, 2, 3, 3, 2, 2, 2, 2, 3, 2, 3, 3, 2, 3, 2,
        ],
        3,
      ),
    ),
  ],
  logs: [
    {
      service: "shopfront",
      level: "info",
      message: 'fetched product {"product.id":<n>,"product.found":true}',
      count: 973,
      firstSeen: "2026-11-01T04:12:18.968Z",
      lastSeen: "2026-11-01T04:57:09.039Z",
      traceId: "c58afe0969b23f5ae3891d7fe7bd92e3",
    },
    {
      service: "shopfront",
      level: "info",
      message: 'stock row missing, returning default {"product.id":<n>}',
      count: 564,
      firstSeen: "2026-11-01T04:12:31.004Z",
      lastSeen: "2026-11-01T04:57:15.407Z",
      traceId: "f0911a1eb58bde281a011f210cbeb14f",
    },
    {
      service: "shopfront",
      level: "info",
      message: 'listed products {"products.count":<n>}',
      count: 504,
      firstSeen: "2026-11-01T04:12:19.379Z",
      lastSeen: "2026-11-01T04:57:15.209Z",
      traceId: "1f7562c42285a6e0371ca597a859d0c8",
    },
    {
      service: "shopfront",
      level: "error",
      message: "23: The operation was aborted due to timeout",
      count: 95,
      firstSeen: "2026-11-01T04:21:27.865Z",
      lastSeen: "2026-11-01T04:55:28.925Z",
      traceId: "08ce4313fa27ee0ef6c009cb073889c5",
    },
    {
      service: "shopfront",
      level: "info",
      message: 'fetched product {"product.id":<n>,"product.found":false}',
      count: 7,
      firstSeen: "2026-11-01T04:15:07.945Z",
      lastSeen: "2026-11-01T04:55:54.475Z",
      traceId: "33b6349f60f01b4fee4d6082f3b9b53d",
    },
    {
      service: "shopfront",
      level: "warn",
      message: 'ops: FF_LIVE_RATINGS turned on {"flag.name":"FF_LIVE_RATINGS"}',
      count: 2,
      firstSeen: "2026-11-01T04:37:18.769Z",
      lastSeen: flagOnAt,
      traceId: "e05d3040f3bfea8651f19e8079c255d7",
    },
    {
      service: "shopfront",
      level: "warn",
      message: 'ops: FF_LIVE_RATINGS turned off {"flag.name":"FF_LIVE_RATINGS"}',
      count: 1,
      firstSeen: "2026-11-01T04:37:26.215Z",
      lastSeen: "2026-11-01T04:37:26.215Z",
      traceId: "abe162cb1572830b415ef3d0f88f3b6d",
    },
  ],
  spans: [
    listing(slowTrace, "04:57:00.165", 2390.4, 518.5, 16),
    {
      traceId: slowTrace,
      service: "postgres",
      name: productsQuery,
      startedAt: "2026-11-01T04:57:00.688Z",
      durationMs: 42.62,
      status: "ok",
      attributes: pg,
    },
    ...reviewSpans.map(([at, durationMs]) => ({
      traceId: slowTrace,
      service: "postgres",
      name: reviewsQuery,
      startedAt: `2026-11-01T${at}Z`,
      durationMs,
      status: "ok" as const,
      attributes: pg,
    })),
    listing("11a0a13daceb9f713548268c50cfe510", "04:57:01.577", 2121.1, 6.4, 16),
    listing("505cad107061780731a8de1cf926204f", "04:57:11.372", 1162.9, 6.4, 16),
    listing("0a32c0bfb2cdfd417cb0656815ce9157", "04:57:07.952", 966.2, 6.9, 16),
    listing("7ee43a807df22d7335d1af8a161202bc", "04:57:04.987", 887.7, 6, 16),
    listing("cdbbef622fd80ee2044db03a123e3d73", "04:37:21.005", 1484.6, 6.9, 16),
    listing("55cb25daa51b71d2311f81c0bb080065", "04:37:20.700", 1017.1, 7.6, 16),
    // Before the flag: the same route, two queries.
    listing("cbbddda25ac66ec84142936a41085c54", "04:54:10.195", 365.6, 0.7, 2),
    listing("22ec15b2e0b3cfa3f35ca097347773c3", "04:54:43.615", 110.9, 0.6, 2),
    listing("24055675fceac3a09d386867820883ab", "04:56:47.847", 19.1, 0.6, 2),
    {
      traceId: "7ab7c3d7e00c5b639816d21a017bb70d",
      service: "shopfront",
      name: "GET /",
      route: "/",
      startedAt: "2026-11-01T04:57:09.417Z",
      durationMs: 3301.5,
      status: "ok",
      attributes: {
        "http.response.status_code": 200,
        "url.path": "/",
        "db.client.connection.wait_time_ms": 67.7,
        "db.queries": 20,
      },
    },
    {
      traceId: "3875b20e14d9d65dff475a495c133321",
      service: "shopfront",
      name: "GET /api/products/[id]",
      route: "/api/products/[id]",
      startedAt: "2026-11-01T04:22:09.383Z",
      durationMs: 1633.5,
      status: "ok",
      attributes: {
        "http.response.status_code": 200,
        "url.path": "/api/products/6",
        "db.client.connection.wait_time_ms": 1529.3,
        "db.queries": 2,
      },
    },
  ],
  db: {
    activity: {
      query:
        "SELECT pid, application_name, state, to_char(now() - state_change, 'HH24:MI:SS') AS in_state_for, left(query, 60) AS last_query FROM pg_stat_activity WHERE datname = 'shopfront' AND pid <> pg_backend_pid() ORDER BY state_change",
      rows: [
        { pid: 92120, application_name: "", state: "idle", in_state_for: "00:00:00", last_query: 'select "rating" from "reviews" where "reviews"."product_id" ' },
        { pid: 91940, application_name: "", state: "idle", in_state_for: "00:00:00", last_query: 'select "on_hand" from "stock_levels" where "stock_levels"."p' },
        { pid: 92122, application_name: "", state: "idle", in_state_for: "00:00:00", last_query: 'select "id", "name", "price_cents", "category", "description' },
        { pid: 92121, application_name: "", state: "idle", in_state_for: "00:00:00", last_query: 'select "id", "name", "price_cents", "category", "description' },
      ],
    },
    locks: {
      query:
        "SELECT pid, pg_blocking_pids(pid)::text AS blocked_by, left(query, 60) AS query FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0",
      rows: [],
    },
    // As recorded: pg_stat_statements counts the whole server, so copying
    // and reseeding the reviews table outweigh the listings' many short
    // reviews queries (7 ms each) in total time.
    slow_queries: {
      query:
        "SELECT left(query, 60) AS query, calls, round(mean_exec_time::numeric, 2) AS mean_ms, round(max_exec_time::numeric, 2) AS max_ms FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 5",
      rows: [
        { query: 'SELECT json_agg(t)::text AS data FROM "public"."reviews" t', calls: "8", mean_ms: "1464.48", max_ms: "1685.55" },
        { query: 'insert into "reviews" (product_id, rating, body, created_at)', calls: "1", mean_ms: "11616.27", max_ms: "11616.27" },
        { query: 'INSERT INTO "public"."reviews" ("id", "product_id", "rating"', calls: "1", mean_ms: "4421.21", max_ms: "4421.21" },
        { query: 'INSERT INTO "public"."reviews" ("id", "product_id", "rating"', calls: "1", mean_ms: "4410.70", max_ms: "4410.70" },
        { query: 'INSERT INTO "public"."reviews" ("id", "product_id", "rating"', calls: "1", mean_ms: "3600.62", max_ms: "3600.62" },
      ],
    },
  },
  files: liveRatingsFiles,
  // What git_log returned in the run, less the README-only commits, with the
  // initial commit's files cut to the ones served here. The listing change
  // wasn't committed yet, so the history stops before it.
  commits: [
    {
      sha: "65717f0",
      author: "teapot2",
      message: "chore: stop logging the ops traffic switch, and widen the blind check",
      files: ["README.md"],
      committedAt: "2026-11-01T03:47:55.000Z",
    },
    {
      sha: "24c3721",
      author: "teapot2",
      message: "feat(shopfront): add info pages, contact form and traffic profiles",
      files: [
        "README.md",
        "package.json",
        "src/app/(store)/care/page.tsx",
        "src/app/(store)/contact/page.tsx",
        "src/app/(store)/journal/page.tsx",
        "src/app/(store)/makers/page.tsx",
        "src/app/(store)/returns/page.tsx",
        "src/app/(store)/shipping/page.tsx",
        "src/app/(store)/wholesale/page.tsx",
        "src/components/contact-form.tsx",
        "src/components/info-page.tsx",
        "src/components/site-footer.tsx",
        "src/lib/info-pages.ts",
      ],
      committedAt: "2026-10-31T05:12:09.000Z",
    },
    {
      sha: "943eba7",
      author: "teapot2",
      message: "feat: add new arrivals to the catalog",
      files: ["src/app/(store)/page.tsx", "src/lib/catalog.ts"],
      committedAt: "2026-10-31T01:08:45.000Z",
    },
    {
      sha: "ebc1cb8",
      author: "teapot2",
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
      committedAt: "2026-10-31T01:08:45.000Z",
    },
    {
      sha: "edaf2d2",
      author: "teapot2",
      message: "chore: initial commit",
      files: [
        "src/app/(store)/page.tsx",
        "src/app/api/health/route.ts",
        "src/app/api/products/route.ts",
        "src/components/product-card.tsx",
        "src/db/client.ts",
        "src/db/schema.ts",
        "src/db/seed.ts",
        "src/lib/catalog.ts",
        "src/lib/flags.ts",
        "src/lib/logger.ts",
        "src/lib/products.ts",
      ],
      committedAt: "2026-10-27T04:13:58.000Z",
    },
  ],
  deploys: [
    {
      service: "shopfront",
      sha: "config:FF_LIVE_RATINGS",
      kind: "config",
      message: "ops: FF_LIVE_RATINGS turned on",
      deployedAt: flagOnAt,
    },
    {
      service: "shopfront",
      sha: "config:FF_LIVE_RATINGS",
      kind: "config",
      message: "ops: FF_LIVE_RATINGS turned off",
      deployedAt: "2026-11-01T04:37:26.215Z",
    },
    {
      service: "shopfront",
      sha: "config:FF_LIVE_RATINGS",
      kind: "config",
      message: "ops: FF_LIVE_RATINGS turned on",
      deployedAt: "2026-11-01T04:37:18.769Z",
    },
  ],
  // Recorded after the flag went off at 04:58:34: 04:59 on, two queries a
  // listing again (05:01's 626 ms is one slow request among ten).
  recovery: [247.24, 124.14, 626.08, 191.24, 462.93].map((value, i) => ({ t: minutesBefore(now, -(i + 2)), value })),
  expected: {
    verdict: "root_cause",
    rootCauseFiles: ["src/lib/ratings.ts"],
    mustMention: [
      // The loop: a query per product.
      ["per product", "each product", "every product", "one query per", "n+1", "n + 1", "in a loop", "loop", "per listing", "per item", "sequential"],
      // What it reads.
      ["reviews", "review rows", "review table"],
      // That it pulls every row and averages in the app instead of in SQL.
      ["average", "aggregat", "in memory", "in application", "in javascript", "in node", "all reviews", "every review", "all the rows", "fetches every"],
    ],
    mitigation: { kind: "flag_off", target: "FF_LIVE_RATINGS" },
  },
};
