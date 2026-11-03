import type { MetricPoint } from "../schema";
import { slowQueriesNote, type LogGroup, type MetricSeries, type SpanRecord } from "../source";
import { minutesBefore, type Scenario } from "./scenario-source";
import { commonCommits, services } from "./shopfront-base";
import { trafficRushFiles } from "./traffic-rush-files";

// Shopfront's traffic rush, recorded live on 2026-11-02: an innocent release
// went out and a rush followed, and nothing was broken. Release 417b767
// ("reword the journal page intro") changes one sentence of the static
// journal page and was deployed at 07:15:58.6Z. The store had been restarted
// at 07:08 with every feature flag off ("flags: loaded") and ran the Normal
// day traffic profile (2 req/s: shoppers, the mobile app, readers and
// crawlers, pages included) from about 07:12. At 07:16:58 the rate was set
// to 6 req/s and held until 07:25:45. The dev server's single thread
// saturates well before that: every page slowed together (the home page
// most, from a p95 of 350 to 600 ms to over 1.5 s), the API routes less,
// the error ratio and the pool stayed flat, and the slow traces run the
// same four queries as before, queued behind rendering. The Page latency
// rule opened the incident at 07:21:38 ("More than 3 requests slower than
// 1500 ms on GET /"). The right answer is that nothing is wrong: the store
// is at capacity, and no change in the window is to blame.
//
// Triage's recorded run (muse-spark-1.3, 55 steps, 2 minutes) fell for the
// trap this scenario keeps: pg_stat_statements still held 84 slow calls of
// the sandbox's reviews copy from an earlier incident, and src/lib/ratings.ts
// holds the live-ratings loop over the reviews table, which only runs with
// FF_LIVE_RATINGS on. It blamed the loop as a root cause, rejected the
// journal deploy, listed "Load spike false alarm" as merely plausible, and
// proposed turning off FF_LIVE_RATINGS, a flag that was already off.
//
// Values below are what Triage's live source reported at the alert (the
// collector files of that run). The recording's traffic before the rush is
// six minutes (07:11 to 07:16); each series repeats those back to the start
// of the window, and the steady log counts are scaled to it, so the rush
// reads against a steady day rather than against the restart. The deploy
// history keeps the one deploy of 417b767 at 07:15:58; the harness's
// deploy-and-rollback check of the same release at 07:11 is left out.

const now = "2026-11-02T07:21:38.279Z";
const deployedAt = "2026-11-02T07:15:58.604Z";
const window = 45;

const release = {
  sha: "417b767",
  branch: "shopfront-release/journal-copy",
  message: "chore(shopfront): reword the journal page intro",
  files: ["src/app/(store)/journal/page.tsx"],
};

// Per-minute points like the live source's: one per minute bucket, the last
// being the bucket `now` is in. `minutes` holds the recorded minutes 07:11
// to 07:21, oldest first, null where the route had no requests that minute
// (the live source then has no point); the first six, before the rate was
// raised at 07:16:58, repeat back to the start of the window.
const minute = 60_000;
const bucket = Math.floor(Date.parse(now) / minute) * minute;
const baselineMinutes = 6;
function recorded(minutes: (number | null)[]): MetricPoint[] {
  const baseline = minutes.slice(0, baselineMinutes).filter((v): v is number => v !== null);
  return Array.from({ length: window }, (_, i) => {
    const minutesAgo = window - 1 - i;
    const index = minutes.length - 1 - minutesAgo;
    const value = index >= 0 ? minutes[index] : baseline[baseline.length - 1 - ((-index - 1) % baseline.length)];
    return value === null ? [] : [{ t: new Date(bucket - minutesAgo * minute).toISOString(), value }];
  }).flat();
}

// The window holds about 3.2 times the requests the recording does (34
// baseline minutes at 2.4 req/s before the recorded eleven), so the steady
// request groups are scaled to it.
const steady = (count: number) => Math.round(count * 3.2);

const route = (name: string, unit: string, description: string, points: MetricPoint[]): MetricSeries => ({
  name,
  service: "shopfront",
  unit,
  description,
  points,
});
// A route's p95 and, as the live source serves beside it, its error ratio:
// 0 in every minute the route had requests.
const latency = (r: string, minutes: (number | null)[]): MetricSeries[] => [
  route(`http.server.request.duration.p95{route=${r}}`, "ms", `p95 latency of ${r}, per minute`, recorded(minutes)),
  route(
    `http.server.error_ratio{route=${r}}`,
    "ratio",
    `Share of ${r} responses with status >= 500, per minute`,
    recorded(minutes.map((v) => (v === null ? null : 0))),
  ),
];

const productsQuery =
  'select "id", "name", "price_cents", "category", "description", "rating_tenths", "review_count", "art", "tint", "created…';
const ratingsQuery =
  'select "id", "rating_tenths", "review_count" from "products" where "products"."id" in ($1, $2, $3, $4, $5, $6, $7, $8, …';
const arrivalsRatingsQuery = 'select "id", "rating_tenths", "review_count" from "products" where "products"."id" in ($1, $2, $3)';
const stockQuery = 'select "on_hand" from "stock_levels" where "stock_levels"."product_id" = $1 limit $2';
const pg = { "db.system.name": "postgresql", "db.namespace": "shopfront" };

const at = (time: string) => `2026-11-02T${time}Z`;

// The access log's line per request, grouped by the live source the way it
// groups them: one group per route, path and status, numbers as <n>. The
// steady groups run from the start of the window.
const accessLine = (method: string, r: string, status: number, path: string) =>
  `${method} ${r} ${status} {"http.request.method":"${method}","http.route":"${r}","http.response.status_code":<n>,"url.path":"${path}","duration_ms":<n>}`;
const request = (r: string, path: string, count: number, lastSeen: string, traceId: string, status = 200): LogGroup => ({
  service: "shopfront",
  level: "info",
  message: accessLine("GET", r, status, path),
  count: steady(count),
  firstSeen: minutesBefore(now, window),
  lastSeen: at(lastSeen),
  traceId,
});
// The warning the access log adds past SLOW_MS (1000 ms), since the rush.
const slow = (r: string, path: string, count: number, firstSeen: string, lastSeen: string, traceId: string): LogGroup => ({
  service: "shopfront",
  level: "warn",
  message: `slow request {"http.request.method":"GET","http.route":"${r}","http.response.status_code":<n>,"url.path":"${path}","duration_ms":<n>}`,
  count,
  firstSeen: at(firstSeen),
  lastSeen: at(lastSeen),
  traceId,
});
// A shopper's search: the catalog's log line, then the request's.
const search = (term: string, count: number, firstSeen: string, lastSeen: string, traceId: string): LogGroup[] => [
  {
    service: "shopfront",
    level: "info",
    message: `catalog: searched {"search.term":"${term}","products.count":<n>}`,
    count,
    firstSeen: at(firstSeen),
    lastSeen: at(lastSeen),
    traceId,
  },
  {
    service: "shopfront",
    level: "info",
    message: accessLine("GET", "/", 200, `/?q=${term}`),
    count,
    firstSeen: at(firstSeen),
    lastSeen: at(lastSeen),
    traceId,
  },
];
// What Shopfront logs as it starts, as recorded at 07:08:50.
const startup = (message: string, time: string): LogGroup => ({
  service: "shopfront",
  level: "info",
  message,
  count: 1,
  firstSeen: at(time),
  lastSeen: at(time),
});

const page = (traceId: string, r: string, path: string, startedAt: string, durationMs: number, wait: number, queries: number): SpanRecord => ({
  traceId,
  service: "shopfront",
  name: `GET ${r}`,
  route: r,
  startedAt: at(startedAt),
  durationMs,
  status: "ok",
  attributes: {
    "http.response.status_code": 200,
    "url.path": path,
    ...(queries ? { "db.client.connection.wait_time_ms": wait, "db.queries": queries } : {}),
  },
});
const query = (traceId: string, name: string, startedAt: string, durationMs: number): SpanRecord => ({
  traceId,
  service: "postgres",
  name,
  startedAt: at(startedAt),
  durationMs,
  status: "ok",
  attributes: pg,
});
// The home page's four queries: the listing, the new arrivals, and the
// stored ratings of each (FF_LIVE_RATINGS is off).
const home = (traceId: string, startedAt: string, durationMs: number, wait: number, queries: [string, number][]): SpanRecord[] => [
  page(traceId, "/", "/", startedAt, durationMs, wait, 4),
  ...queries.map(([startedAt, durationMs], i) => query(traceId, [productsQuery, productsQuery, arrivalsRatingsQuery, ratingsQuery][i], startedAt, durationMs)),
];

export const trafficRush: Scenario = {
  id: "traffic-rush",
  label: "Traffic rush (innocent deploy)",
  description: "Pages slow down after a copy-only deploy as traffic triples",
  now,
  alert: {
    title: "More than 3 requests slower than 1500 ms on GET /",
    service: "shopfront",
    severity: "sev3",
    metric: "http.server.request.duration.p95{route=/}",
    threshold: 1500,
  },
  services,
  metrics: [
    ...latency("/", [488.23, 798.85, 589.68, 966.38, 349.95, 351.3, 541.79, 854.91, 1119.3, 1335.75, 1543.3]),
    ...latency("/products/[id]", [339.02, 540.14, 361.2, 501.9, 349.56, 268.4, 460.82, 635.52, 828.84, 892.77, 1191.34]),
    ...latency("/journal", [63.62, 63.71, 65.33, null, null, 96.91, 65.38, 97.05, 1246.02, 175.13, 2005.31]),
    ...latency("/cart", [66.1, 108.61, 304.91, 310.48, 77, 70.92, 224.94, 475.91, 94.54, 223.85, 884.64]),
    ...latency("/care", [251.54, 403.92, 187.73, 266.82, 74.13, 66.73, 192.03, 278.82, 193.75, 412.84, 573.77]),
    ...latency("/shipping", [73, 315.64, 61.75, 646.35, 285.13, 63.3, 134.81, 375, 463.48, 75.54, 1717.26]),
    ...latency("/returns", [81.4, 68.25, 64.9, 251.95, 64.64, 59.9, 179.17, 579.69, 960.69, 279.58, 763.79]),
    ...latency("/contact", [65.44, 64.42, 64.5, 183.16, 69.61, 68.65, null, 457.14, 601.63, 69.69, null]),
    ...latency("/makers", [null, 81.25, 197.08, 58.67, 591.1, null, 186.66, 69.98, 252.76, null, 189.03]),
    ...latency("/wholesale", [71.01, null, 174.48, 61.69, null, null, 76.15, 937.45, 314.05, 73.34, 141.07]),
    ...latency("/_not-found", [69.65, 69.99, 276.02, 76.61, 88.33, 73.95, 71.33, 646.68, 497.88, 413.92, 1264.01]),
    ...latency("/api/health", [17.44, 26.14, 8.72, 26.13, 9.05, 6.98, 12.81, 37.97, 60.92, 9.95, 6.73]),
    ...latency("/api/products", [16.13, 62.84, 8.93, 111.57, 44.25, 14.37, 10.82, 92.75, 79.64, 18.28, 135.62]),
    ...latency("/api/products/[id]", [15.18, 95.26, 18.67, 33.69, 58.17, 19.24, 100.7, 52.31, 99.68, 94.89, 136.19]),
    route(
      "http.server.request.rate",
      "req/s",
      "Requests per second across all routes",
      recorded([2.22, 3.03, 2.28, 2.97, 2.63, 1.4, 3.03, 4.03, 4.92, 5.3, 5.64]),
    ),
    route("http.server.error_ratio", "ratio", "Share of responses with status >= 500", recorded([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    route(
      "db.client.connection.count{state=used}",
      "connections",
      "pg pool connections in this state (pool max 10)",
      recorded([1, 1, 1, 1, 1, 1, 2, 2, 1, 1, 1]),
    ),
    route(
      "db.client.connection.count{state=idle}",
      "connections",
      "pg pool connections in this state (pool max 10)",
      recorded([2, 3, 1, 1, 1, 1, 1, 0, 3, 2, 3]),
    ),
    route("db.client.connection.max", "connections", "pg pool size limit", recorded([10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10])),
    route(
      "nodejs.eventloop.utilization",
      "ratio",
      "Event loop utilization",
      recorded([0.15, 0.32, 0.2, 0.33, 0.13, 0.11, 0.42, 0.29, 0.63, 0.42, 0.75]),
    ),
    route(
      "db.client.connection.pending_requests",
      "requests",
      "Requests waiting for a pg pool connection (peak per minute)",
      recorded([1, 2, 2, 2, 1, 1, 2, 2, 2, 1, 1]),
    ),
  ],
  logs: [
    request("/", "/", 264, "07:21:34.144", "ceabd09e381338c1c00a8a3205f4bf4b"),
    {
      service: "shopfront",
      level: "info",
      message: 'stock row missing, returning default {"product.id":<n>}',
      count: steady(188),
      firstSeen: minutesBefore(now, window),
      lastSeen: "2026-11-02T07:21:37.174Z",
      traceId: "8e5025aa245b122c748849c56329abae",
    },
    request("/api/products", "/api/products", 172, "07:21:33.994", "b7b057e86ea02b7cb34b500a8fe9001b"),
    request("/products/[id]", "/products/1", 97, "07:21:34.898", "b0900f8fec4a4bd0a24609447b32ac76"),
    request("/products/[id]", "/products/3", 95, "07:21:34.129", "4153965f4d6e5964e0104f984fbac386"),
    request("/products/[id]", "/products/6", 88, "07:21:30.186", "fb64a43033fd88809dee0f4540ced5ca"),
    request("/products/[id]", "/products/7", 81, "07:21:31.825", "03c77bbe57cfc8760aaa6f71d10dd5b3"),
    request("/products/[id]", "/products/10", 74, "07:21:31.823", "aefde8e75b1020673abfc71eb1d93ba4"),
    request("/products/[id]", "/products/8", 70, "07:21:34.143", "1ebee717fa3bb11f616095142413db1e"),
    request("/api/health", "/api/health", 67, "07:21:35.169", "4e7f99e1fc2d4dbcf85db58cde5f0e5c"),
    request("/products/[id]", "/products/2", 63, "07:21:23.238", "43a2d8abd67554f0d92a047ce1a28d45"),
    request("/_not-found", "/robots.txt", 61, "07:21:34.546", "0739f624faaa7c50149aa5bdbbabfa3e", 404),
    request("/shipping", "/shipping", 58, "07:21:37.710", "2e52069d42fb73fecd00918f5ecfacaa"),
    request("/cart", "/cart", 55, "07:21:33.117", "85a9ccede152a6b3b85f66c13afe1a37"),
    request("/products/[id]", "/products/11", 54, "07:21:26.508", "03c0392215a4a7d2c1ed3560e1dd20a5"),
    request("/api/products/[id]", "/api/products/6", 52, "07:21:36.251", "0cd7628e0a2a9969d90334677de27f5e"),
    request("/products/[id]", "/products/4", 51, "07:21:33.123", "ae1135604382dee425bd452174fa0133"),
    request("/api/products/[id]", "/api/products/1", 49, "07:21:36.838", "259576b81e5d604be066f28339cd5cf4"),
    request("/", "/?category=Tableware", 47, "07:21:30.182", "2ac8194e59438a9ef13b3d79e87cd4a5"),
    request("/returns", "/returns", 45, "07:21:32.419", "d12ff2bb76382969ce0adc4e611cb3ed"),
    request("/products/[id]", "/products/12", 40, "07:21:35.050", "4063f995290dbe9e080bcbc0f2a91d18"),
    request("/products/[id]", "/products/62", 38, "07:21:24.159", "c794d809a4bd42d73eaf9acbe1d11e70"),
    request("/products/[id]", "/products/61", 37, "07:21:17.983", "65503c5548b1b31d1c5d2d3b1c15348d"),
    request("/products/[id]", "/products/63", 36, "07:21:34.895", "dd7be1f87c0f15773f43ccbe79cd7b8c"),
    request("/products/[id]", "/products/9", 35, "07:21:23.235", "cfa480f583c1afdb18edb327b4cddf41"),
    request("/care", "/care", 35, "07:21:34.138", "4a99c9caf3cebc414eca02c4574681f6"),
    request("/", "/?category=Home", 30, "07:21:33.125", "f25f0c59b01afb2b6c65c5625cbf0ec1"),
    request("/products/[id]", "/products/5", 30, "07:21:21.113", "570002f025dc312b564e4aee1a6ecb33"),
    request("/api/products/[id]", "/api/products/3", 29, "07:21:14.923", "4f200227e5cb1f0dae1582328fa45071"),
    request("/api/products/[id]", "/api/products/7", 26, "07:21:35.428", "3fdecfdffc1e4337a0803c46c5c6c33b"),
    request("/api/products/[id]", "/api/products/10", 25, "07:21:10.551", "9bd150ecbc5c0eaa941671263ae77ec6"),
    request("/", "/?category=Linen", 24, "07:21:30.184", "9c777b95b5efd7835fd98a6a03e9fb4c"),
    {
      service: "shopfront",
      level: "info",
      message: 'stock: low-stock sweep done {"stock.low_count":<n>,"duration_ms":<n>}',
      count: 23,
      firstSeen: minutesBefore(now, window),
      lastSeen: "2026-11-02T07:21:10.745Z",
    },
    request("/api/products/[id]", "/api/products/2", 23, "07:21:08.431", "6edfe60c5fa4862e5262eabb6dd12309"),
    request("/api/products/[id]", "/api/products/4", 23, "07:21:02.156", "d0015be3e0aa61f875399548786a6817"),
    request("/contact", "/contact", 22, "07:20:41.751", "630053663cb698d0e340c6f21e7a690f"),
    request("/", "/?category=Kitchen", 20, "07:21:19.419", "4f44d890135edca07bfdf2cfdefb8ce3"),
    request("/journal", "/journal", 19, "07:21:37.675", "d6cdaa7ac2162ee694b6f4b57079b6c5"),
    request("/api/products/[id]", "/api/products/9", 17, "07:21:14.797", "d1fa1bc4e5c660136b9fa2b0f1c98ad8"),
    request("/makers", "/makers", 17, "07:21:26.739", "367213e8e45ad527d520cc6bb499ce30"),
    request("/api/products/[id]", "/api/products/12", 16, "07:21:15.466", "375ff04ef63c3c75c0bc0003beb44416"),
    request("/api/products/[id]", "/api/products/11", 15, "07:20:50.737", "1d1b882ac3c520fe715830351cd76d5f"),
    request("/wholesale", "/wholesale", 14, "07:21:33.121", "2870022b57230fd8afce80fcda2ee2fc"),
    request("/api/products/[id]", "/api/products/8", 13, "07:21:01.101", "c9b159443223be7c97e64a612131f929"),
    request("/api/products/[id]", "/api/products/63", 12, "07:20:38.324", "97ec93b1a0d7179c39b3d21af7b410ba"),
    request("/api/products/[id]", "/api/products/5", 10, "07:21:18.424", "53411e4d2e07ac3220082c75aef78886"),
    request("/api/products/[id]", "/api/products/61", 7, "07:21:37.173", "8e5025aa245b122c748849c56329abae"),
    request("/api/products/[id]", "/api/products/62", 6, "07:21:30.454", "659924c8a88d8dfd04f3d0833ee17c17"),
    ...search("linen", 6, "07:14:14.831", "07:21:26.892", "f5f69c02054cead05cfe075bbc4219aa"),
    ...search("kettle", 5, "07:10:43.608", "07:19:05.882", "bd0cffb6954d1e5170c256b108976268"),
    ...search("stoneware", 4, "07:11:31.913", "07:16:49.105", "111a04a761cddf01a66b6655b71065a1"),
    ...search("storage", 2, "07:14:27.185", "07:20:12.631", "4d6fdc3c489c39668fddf0b2a98a673c"),
    ...search("planter", 2, "07:19:25.057", "07:20:47.866", "57918ad6c014d47427335982792167e4"),
    {
      service: "shopfront",
      level: "info",
      message: accessLine("GET", "/products/[id]", 404, "/products/null"),
      count: 2,
      firstSeen: "2026-11-02T07:13:09.737Z",
      lastSeen: "2026-11-02T07:20:26.283Z",
      traceId: "854a0ba873067033294f1b74c2c53226",
    },
    // The slow-request warnings: 19 on the home page since the rush, then
    // the product pages, the category listings, the journal and shipping.
    slow("/", "/", 19, "07:14:54.619", "07:21:30.194", "12f953b18b3b1a3fb1b7dbf18ee8e8f1"),
    slow("/products/[id]", "/products/1", 4, "07:21:12.739", "07:21:30.045", "3103bc7dde725ccf164a3eae82aa0a65"),
    slow("/products/[id]", "/products/3", 3, "07:18:25.348", "07:20:19.845", "49d6c7b467e71f5d8130d4ba2b0ebbe3"),
    slow("/journal", "/journal", 2, "07:19:47.649", "07:21:37.675", "d6cdaa7ac2162ee694b6f4b57079b6c5"),
    slow("/", "/?category=Tableware", 2, "07:19:47.675", "07:21:30.182", "2ac8194e59438a9ef13b3d79e87cd4a5"),
    slow("/products/[id]", "/products/10", 2, "07:21:19.398", "07:21:31.823", "aefde8e75b1020673abfc71eb1d93ba4"),
    slow("/products/[id]", "/products/11", 2, "07:21:19.403", "07:21:23.228", "a923ce27e49b573c3a3938057616e63e"),
    slow("/", "/?category=Kitchen", 1, "07:19:47.668", "07:19:47.668", "edcc7efc984eb45bfaf7f09d07b37aca"),
    slow("/products/[id]", "/products/12", 1, "07:20:05.151", "07:20:05.151", "b3039888ae7ffea2dfd967351f1b7da4"),
    slow("/products/[id]", "/products/2", 1, "07:20:19.598", "07:20:19.598", "c660a8fe2429f545b55e107175dd4dd8"),
    slow("/products/[id]", "/products/7", 1, "07:20:19.850", "07:20:19.850", "0603adfb53995d42ee51db3d629a828f"),
    slow("/products/[id]", "/products/63", 1, "07:21:30.018", "07:21:30.018", "a56410133c0ee87f797ae72adba320bb"),
    slow("/products/[id]", "/products/6", 1, "07:21:30.042", "07:21:30.042", "8d09a108ae526e814d9afc58ae203a1e"),
    slow("/shipping", "/shipping", 1, "07:21:37.710", "07:21:37.710", "2e52069d42fb73fecd00918f5ecfacaa"),
    // The restart at 07:08:50, every flag off.
    startup(
      'server: started {"service.version":"0.1.0","deployment.environment":"development","node.version":"v26.3.0","process.pid":<n>,"server.port":<n>,"log.level":"info","telemetry.endpoint":"http://localhost:4318"}',
      "07:08:50.631",
    ),
    startup('flags: loaded {"flag.FF_STOCK_DIRECT_QUERY":false,"flag.FF_LIST_PRICES":false,"flag.FF_LIVE_RATINGS":false}', "07:08:50.632"),
    startup('db: pool created {"db.pool.max":<n>,"db.pool.connect_timeout_ms":<n>}', "07:08:50.687"),
    startup('jobs: scheduled {"jobs.low_stock_sweep.every_ms":<n>}', "07:08:50.688"),
    {
      ...startup(accessLine("HEAD", "/", 200, "/"), "07:08:51.862"),
      traceId: "226426f6b6d2d6c137866329c48e0e7e",
    },
    {
      service: "shopfront",
      level: "warn",
      message: `deploy: ${release.sha} ${release.message} {"deploy.sha":"${release.sha}","deploy.message":"${release.message}","deploy.kind":"deploy","deploy.branch":"${release.branch}"}`,
      count: 1,
      firstSeen: deployedAt,
      lastSeen: deployedAt,
      traceId: "5b943b1d72e2283e50336f735d4418ff",
    },
  ],
  spans: [
    // The slow home pages of the rush: the same four queries, a few
    // milliseconds each, inside 1.4 to 1.7 s of waiting on the event loop.
    ...home("25cd0df70a96584cf995bd26b5539655", "07:21:21.553", 1701.7, 27.9, [
      ["07:21:21.621", 32.27],
      ["07:21:21.652", 7.61],
      ["07:21:21.654", 9.31],
      ["07:21:21.661", 27.55],
    ]),
    ...home("5467cf9bac2ce4dcc8922d2ef5a2ae70", "07:21:28.508", 1684, 31.2, [
      ["07:21:28.572", 33.3],
      ["07:21:28.601", 5.9],
      ["07:21:28.607", 31.51],
      ["07:21:28.608", 31.43],
    ]),
    ...home("da5793450f11f9fae361795e3b98a92e", "07:20:39.534", 1550.6, 29.7, [
      ["07:20:39.601", 31.63],
      ["07:20:39.632", 6.29],
      ["07:20:39.633", 6.03],
      ["07:20:39.639", 23.24],
    ]),
    ...home("49515c83d29e0cd44408327e4cb40e39", "07:21:05.472", 1543.3, 26.9, [
      ["07:21:05.533", 29.79],
      ["07:21:05.561", 6.87],
      ["07:21:05.564", 5.86],
      ["07:21:05.569", 20.25],
    ]),
    ...home("1ac42083b51a70e7e17a98913f3e386a", "07:21:21.782", 1541.1, 31.1, [
      ["07:21:21.855", 33.28],
      ["07:21:21.887", 7.27],
      ["07:21:21.889", 6.41],
      ["07:21:21.895", 23.1],
    ]),
    ...home("a91f436d2513589706173edc9cd73a70", "07:19:58.806", 1423.1, 26.7, [
      ["07:19:58.865", 28.08],
      ["07:19:58.892", 5.34],
      ["07:19:58.894", 9.71],
      ["07:19:58.897", 6.48],
    ]),
    // The product pages, slow the same way with their three queries, and
    // the static journal page, which has none.
    page("a56410133c0ee87f797ae72adba320bb", "/products/[id]", "/products/63", "07:21:28.388", 1630, 8.1, 3),
    query("a56410133c0ee87f797ae72adba320bb", productsQuery, "07:21:28.412", 11.94),
    query("a56410133c0ee87f797ae72adba320bb", productsQuery, "07:21:28.477", 2.29),
    query("a56410133c0ee87f797ae72adba320bb", stockQuery, "07:21:28.477", 1.82),
    page("49d6c7b467e71f5d8130d4ba2b0ebbe3", "/products/[id]", "/products/3", "07:20:18.371", 1474.5, 7.1, 3),
    query("49d6c7b467e71f5d8130d4ba2b0ebbe3", productsQuery, "07:20:18.395", 12.43),
    query("49d6c7b467e71f5d8130d4ba2b0ebbe3", productsQuery, "07:20:18.455", 8.24),
    query("49d6c7b467e71f5d8130d4ba2b0ebbe3", stockQuery, "07:20:18.455", 7.64),
    page("43b21602f69be834f46cc5435a1d4b36", "/products/[id]", "/products/1", "07:21:28.614", 1426.3, 7.5, 3),
    page("d6cdaa7ac2162ee694b6f4b57079b6c5", "/journal", "/journal", "07:21:35.670", 2005.3, 0, 0),
    page("f984900608c42bb10ebe4600f7f173e4", "/journal", "/journal", "07:19:46.403", 1246, 0, 0),
    // Before the rush: the home page with the same queries, in a third of
    // the time.
    ...home("910ab981eda23b32e954fea5fbeb77ff", "07:13:10.798", 589.7, 28.9, [
      ["07:13:10.861", 29.52],
      ["07:13:10.888", 4.19],
      ["07:13:10.892", 6.97],
      ["07:13:10.893", 6.76],
    ]),
    ...home("5e2922c8548a8c368db4f26d4dc8484c", "07:15:30.825", 349.9, 29.5, [
      ["07:15:30.891", 60.65],
      ["07:15:30.921", 46.98],
      ["07:15:30.952", 18.11],
      ["07:15:30.969", 42.31],
    ]),
    page("14d68feb3c6a764a2154b2046b7a9111", "/", "/", "07:13:07.048", 326.7, 27.8, 4),
    // The API routes, which render nothing, barely slower in the rush.
    page("83d3d912716a17d7a4fc54d58a335ac2", "/api/products", "/api/products", "07:21:01.323", 135.6, 0.5, 2),
    query("83d3d912716a17d7a4fc54d58a335ac2", productsQuery, "07:21:01.349", 22.24),
    query("83d3d912716a17d7a4fc54d58a335ac2", ratingsQuery, "07:21:01.371", 86.45),
    page("1e5f8eecca3d14f9971333d6cf664df9", "/api/products", "/api/products", "07:20:53.609", 62.3, 0.4, 2),
    page("c488b33ce0b1beefb05d4ed83d4e96e4", "/api/products", "/api/products", "07:14:53.688", 111.6, 0.3, 2),
    page("8e5025aa245b122c748849c56329abae", "/api/products/[id]", "/api/products/61", "07:21:37.036", 137.9, 0.4, 2),
    query("8e5025aa245b122c748849c56329abae", productsQuery, "07:21:37.046", 46.52),
    query("8e5025aa245b122c748849c56329abae", stockQuery, "07:21:37.093", 80.33),
    page("57f8352225b605a755e76cef5a02fa73", "/api/products/[id]", "/api/products/7", "07:21:21.689", 136.2, 0.4, 2),
    page("0cd7628e0a2a9969d90334677de27f5e", "/api/products/[id]", "/api/products/6", "07:21:36.125", 126.8, 0.4, 2),
  ],
  db: {
    activity: {
      query:
        "SELECT pid, application_name, state, to_char(now() - state_change, 'HH24:MI:SS') AS in_state_for, left(query, 60) AS last_query FROM pg_stat_activity WHERE datname = 'shopfront' AND pid <> pg_backend_pid() AND application_name NOT IN ('triage', 'triage-sandbox') ORDER BY state_change",
      rows: [
        { pid: 83158, application_name: "", state: "idle", in_state_for: "00:00:06", last_query: 'select "id", "name", "price_cents", "category", "description' },
        { pid: 82981, application_name: "", state: "idle", in_state_for: "00:00:00", last_query: 'select "id", "name", "price_cents", "category", "description' },
        { pid: 83194, application_name: "", state: "idle", in_state_for: "00:00:00", last_query: 'select "on_hand" from "stock_levels" where "stock_levels"."p' },
        { pid: 83070, application_name: "", state: "idle", in_state_for: "00:00:00", last_query: 'select "id", "name", "price_cents", "category", "description' },
      ],
    },
    locks: {
      query:
        "SELECT pid, pg_blocking_pids(pid)::text AS blocked_by, left(query, 60) AS query FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0",
      rows: [],
    },
    // As the live source showed it: pg_stat_statements keeps its totals
    // since the server started, so the sandbox's copy of the reviews table
    // from an earlier incident is still on the list, 84 calls of 1.3 s
    // each, none of them in the window (runs blamed it before the window
    // columns said so). The app's own queries are the four others, a
    // fraction of a millisecond each.
    slow_queries: {
      query:
        "SELECT left(query, 60) AS query, calls, round(mean_exec_time::numeric, 2) AS mean_ms, round(max_exec_time::numeric, 2) AS max_ms FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) AND query NOT LIKE '%/* triage */%' AND query NOT LIKE '%pg_stat_statements%' AND query NOT ILIKE 'CREATE DATABASE%' AND query NOT ILIKE 'DROP DATABASE%' AND calls >= 10 ORDER BY total_exec_time DESC LIMIT 5",
      rows: [
        { query: 'select "on_hand" from "stock_levels" where "stock_levels"."p', calls: "32276", mean_ms: "0.03", max_ms: "0.66", window_calls: 4200, window_ms: 126 },
        { query: 'select "id", "name", "price_cents", "category", "description', calls: "23673", mean_ms: "0.03", max_ms: "0.89", window_calls: 3100, window_ms: 93 },
        { query: 'select "id", "name", "price_cents", "category", "description', calls: "32697", mean_ms: "0.02", max_ms: "0.61", window_calls: 4300, window_ms: 86 },
        { query: 'select "id", "name", "price_cents", "category", "description', calls: "10536", mean_ms: "0.05", max_ms: "0.68", window_calls: 1400, window_ms: 70 },
        { query: 'SELECT json_agg(t)::text AS data FROM "public"."reviews" t', calls: "84", mean_ms: "1343.20", max_ms: "2290.10", window_calls: 0, window_ms: 0 },
      ],
      note: slowQueriesNote(now, 15),
    },
  },
  files: trafficRushFiles,
  // The store's history as the live git log showed it from the release,
  // newest first; the initial commit's list is cut to the files served.
  commits: [
    {
      sha: release.sha,
      author: "teapot2",
      message: release.message,
      files: release.files,
      committedAt: "2026-11-02T07:11:21.000Z",
    },
    {
      sha: "21166f5",
      author: "teapot2",
      message: "feat: re-run incidents with other models, release rollbacks and web search",
      files: [
        ".env.example",
        "README.md",
        "package.json",
        "src/app/(store)/page.tsx",
        "src/app/(store)/products/[id]/loading.tsx",
        "src/app/(store)/products/[id]/page.tsx",
        "src/app/api/products/[id]/route.ts",
        "src/app/api/products/route.ts",
        "src/db/client.ts",
        "src/instrumentation.node.ts",
        "src/instrumentation.ts",
        "src/lib/access-log.ts",
        "src/lib/cart.ts",
        "src/lib/jobs.ts",
        "src/lib/logger.ts",
        "src/lib/products.ts",
        "src/lib/traffic-profile.test.ts",
      ],
      committedAt: "2026-11-02T06:30:53.000Z",
    },
    {
      sha: "e5ac370",
      author: "teapot2",
      message: "feat(shopfront): live ratings from the reviews table, behind FF_LIVE_RATINGS",
      files: [
        "README.md",
        "drizzle/0005_reviews.sql",
        "drizzle/meta/0005_snapshot.json",
        "drizzle/meta/_journal.json",
        "src/app/(store)/page.tsx",
        "src/app/api/health/route.ts",
        "src/app/api/products/route.ts",
        "src/db/client.ts",
        "src/db/schema.ts",
        "src/db/seed.ts",
        "src/lib/flags.ts",
        "src/lib/ratings.ts",
      ],
      committedAt: "2026-11-01T05:14:19.000Z",
    },
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
      sha: "0732568",
      author: "teapot2",
      message: "docs: data-change gate, price-gap scenario, and what the price list gap returns",
      files: ["README.md"],
      committedAt: "2026-10-31T03:18:33.000Z",
    },
    {
      sha: "7b13bf7",
      author: "teapot2",
      message: "chore(ops): one flag at a time on the demo controls",
      files: ["README.md"],
      committedAt: "2026-10-31T01:08:46.000Z",
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
        ".env.example",
        "README.md",
        "drizzle.config.ts",
        "drizzle/0000_omniscient_satana.sql",
        "drizzle/0001_flawless_sage.sql",
        "drizzle/0002_tired_stature.sql",
        "drizzle/0003_pg_stat_statements.sql",
        "next.config.ts",
        "package.json",
        "src/app/(store)/page.tsx",
        "src/app/(store)/products/[id]/loading.tsx",
        "src/app/(store)/products/[id]/page.tsx",
        "src/app/api/health/route.ts",
        "src/app/api/products/[id]/route.ts",
        "src/app/api/products/route.ts",
        "src/components/product-card.tsx",
        "src/db/client.ts",
        "src/db/schema.ts",
        "src/db/seed.ts",
        "src/lib/cart.ts",
        "src/lib/catalog.ts",
        "src/lib/flags.ts",
        "src/lib/logger.ts",
        "src/lib/products.ts",
        "src/lib/stock.ts",
      ],
      committedAt: "2026-10-27T04:13:58.000Z",
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
  ],
  // Recorded after the alert: nothing was changed, so the home page stayed
  // slow for the four minutes the rate stayed at 6 req/s, then fell back
  // under the threshold the minute after the rate returned to 2 (07:25:45).
  // Only a wrongly approved mitigation in a replay shows it.
  recovery: [3620.64, 1988.46, 2761.35, 3359.16, 562.86, 349.52, 435.43, 357.18].map((value, i) => ({
    t: new Date(bucket + (i + 1) * minute).toISOString(),
    value,
  })),
  expected: {
    verdict: "no_defect",
    rootCauseFiles: [],
    mustMention: [
      ["traffic", "load", "rush", "request rate", "requests per second", "req/s", "rps", "volume", "demand", "surge", "spike", "capacity", "saturat"],
    ],
    mitigation: "none",
  },
};
