import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import type { MetricPoint } from "../schema";
import type {
  CommitRecord,
  DbCheck,
  DbResult,
  DeployRecord,
  LogGroup,
  SourceDescription,
  SpanRecord,
  TelemetrySource,
} from "../source";
import { type Attrs, type LogRow, type MetricRow, readTelemetry, type SpanRow } from "./otlp-files";

// The running Shopfront, read from what it really emitted: OTLP spans, logs
// and metrics from the collector's files, Postgres itself for diagnostics,
// and the app's source tree. The telemetry is snapshotted when the source is
// created (the alert time), so every query in one investigation sees the
// same data. Diagnostics and source reads are live.

export const shopfrontDir = path.resolve(
  /* turbopackIgnore: true */ process.env.SHOPFRONT_DIR ??
    path.join(/* turbopackIgnore: true */ process.cwd(), "..", "shopfront"),
);
const databaseUrl =
  process.env.SHOPFRONT_DATABASE_URL ?? "postgres://triage:triage@localhost:5433/shopfront";

// The alert the live run starts from: the same one the pool-leak scenario fires.
export const liveAlert = {
  route: "/api/products/[id]",
  metric: "http.server.request.duration.p95{route=/api/products/[id]}",
  threshold: 500,
};

const services = [
  { name: "shopfront", dependsOn: ["postgres"] },
  { name: "postgres", dependsOn: [] },
];

const PENDING = "db.client.connection.pending_requests";
// OTel metrics worth offering the agent, beyond those derived from spans.
// pending_requests is derived from spans instead (see pendingSeries).
const metricAllowlist = (name: string) =>
  (name.startsWith("db.client.connection.") && name !== PENDING) || name === "nodejs.eventloop.utilization";

// Shorter than the semconv descriptions the instrumentation exports.
const descriptions: Record<string, string> = {
  "db.client.connection.count": "pg pool connections in this state",
  "db.client.connection.max": "pg pool size limit",
};

const MINUTE = 60_000;
const levelRank = { debug: 0, info: 1, warn: 2, error: 3 } as const;

interface Series {
  name: string;
  service: string;
  unit: string;
  description: string;
  points: (windowMinutes: number) => MetricPoint[];
}

// Next.js's server span for each request, the one that knows the route.
// Requests to the demo harness's routes (see harnessPaths) don't count: the
// watch never judges them and the agent never sees them.
export const harnessRoutes = ["/ops", "/api/ops"];
const routeOf = (s: SpanRow) => String(s.attributes["http.route"]);
const isRequest = (s: SpanRow) =>
  s.scope === "next.js" && s.kind === 2 && typeof s.attributes["http.route"] === "string" && !harnessRoutes.includes(routeOf(s));
const statusCode = (s: SpanRow) => Number(s.attributes["http.status_code"] ?? s.attributes["http.response.status_code"] ?? 0);
const failed = (s: SpanRow) => s.error || statusCode(s) >= 500;
const duration = (s: SpanRow) => s.end - s.start;
const methodOf = (s: SpanRow) =>
  String(s.attributes["http.method"] ?? s.attributes["http.request.method"] ?? s.name.split(" ")[0] ?? "GET");

export interface RequestSample {
  service: string;
  route: string;
  method: string;
  start: number;
  durationMs: number;
  // The HTTP status, 0 when the span didn't record one.
  status: number;
  failed: boolean;
  traceId: string;
}

// The requests among `spans` that started in (from, to], as samples.
export function requestSamples(spans: SpanRow[], from: number, to: number): RequestSample[] {
  return spans
    .filter((s) => isRequest(s) && s.start > from && s.start <= to)
    .map((s) => ({
      service: s.service,
      route: routeOf(s),
      method: methodOf(s),
      start: s.start,
      durationMs: duration(s),
      status: statusCode(s),
      failed: failed(s),
      traceId: s.traceId,
    }));
}

// Every request in the last `windowMs`, straight from the request spans:
// what the watch's rules are judged on. Cheap enough to read every few
// seconds, and measured the same way as the series an investigation sees.
export async function recentRequests(windowMs: number): Promise<RequestSample[]> {
  const now = Date.now();
  const { spans } = await readTelemetry();
  return requestSamples(spans, now - windowMs, now);
}

// `now` anchors the source at another time than the call's: an alert's,
// to look at a finished incident's window as it was (sourceFor).
export async function createLiveSource(opts: { now?: number } = {}): Promise<TelemetrySource> {
  const now = opts.now ?? Date.now();
  const all = await readTelemetry();
  const spans = all.spans.filter((s) => s.start <= now);
  const logs = all.logs.filter((l) => l.time <= now);
  const metrics = all.metrics.filter((m) => m.time <= now);

  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const children = new Map<string, SpanRow[]>();
  for (const s of spans) {
    if (!s.parentSpanId) continue;
    const list = children.get(s.parentSpanId);
    if (list) list.push(s);
    else children.set(s.parentSpanId, [s]);
  }
  const requests = spans.filter(isRequest);
  const requestOf = (s: SpanRow): SpanRow | undefined => {
    for (let cur: SpanRow | undefined = s, hops = 0; cur && hops < 50; cur = byId.get(cur.parentSpanId ?? ""), hops++) {
      if (isRequest(cur)) return cur;
    }
    return undefined;
  };
  const subtree = (root: SpanRow): SpanRow[] => {
    const out: SpanRow[] = [];
    const stack = [...(children.get(root.spanId) ?? [])];
    while (stack.length && out.length < 500) {
      const s = stack.pop()!;
      out.push(s);
      stack.push(...(children.get(s.spanId) ?? []));
    }
    return out;
  };

  const catalog: Series[] = [
    ...spanSeries(requests, now, { statusCode, failed, duration }),
    ...metricSeries(metrics, now),
    // A checkout from a free pool takes well under a millisecond; one that
    // took 5 ms or more waited.
    pendingSeries(spans.filter((s) => s.name === "pg-pool.connect" && s.end - s.start >= 5), now),
  ];

  // Exceptions recorded on spans, as error logs: Next.js route handlers
  // throw rather than log, so this is where their errors are. Counted once
  // per request even when several spans in it record the same exception.
  const exceptionLogs: LogRow[] = [];
  const seen = new Set<string>();
  for (const s of spans) {
    for (const e of s.events) {
      if (e.name !== "exception") continue;
      const body = `${e.attributes["exception.type"] ?? "Error"}: ${exceptionMessage(s, e.attributes)}`;
      const key = `${requestOf(s)?.spanId ?? s.spanId}|${body}`;
      if (seen.has(key)) continue;
      seen.add(key);
      exceptionLogs.push({ time: e.time || s.end, service: s.service, level: "error", body, attributes: {}, traceId: s.traceId });
    }
  }
  const allLogs = [...logs, ...exceptionLogs];
  const since = (minutes: number) => now - minutes * MINUTE;

  const description: SourceDescription = {
    id: "live:shopfront",
    now: new Date(now).toISOString(),
    services,
    metrics: catalog.map(({ name, service, unit, description }) => ({ name, service, unit, description })),
  };

  return {
    describe: () => description,

    async queryLogs({ service, minLevel, contains, windowMinutes }) {
      const groups = new Map<string, LogGroup>();
      for (const l of allLogs) {
        if (l.time < since(windowMinutes)) continue;
        if (service && l.service !== service) continue;
        if (minLevel && levelRank[l.level] < levelRank[minLevel]) continue;
        const message = template(l);
        if (contains && !message.toLowerCase().includes(contains.toLowerCase())) continue;
        const key = `${l.service}|${l.level}|${message}`;
        const iso = new Date(l.time).toISOString();
        const g = groups.get(key);
        if (!g) {
          groups.set(key, { service: l.service, level: l.level, message, count: 1, firstSeen: iso, lastSeen: iso, traceId: l.traceId });
          continue;
        }
        g.count++;
        if (iso < g.firstSeen) g.firstSeen = iso;
        if (iso > g.lastSeen) {
          g.lastSeen = iso;
          g.traceId = l.traceId ?? g.traceId;
        }
      }
      return [...groups.values()].sort((a, b) => b.count - a.count);
    },

    async queryTraces({ service, route, status, minDurationMs, limit }) {
      const candidates: SpanRecord[] = [];
      if (!service || service === "shopfront") {
        for (const r of requests) candidates.push(requestRecord(r, subtree(r), statusCode, failed));
      }
      if (!service || service === "postgres") {
        for (const s of spans) if (s.attributes["db.system.name"] === "postgresql" && s.name.startsWith("pg.query")) candidates.push(queryRecord(s));
      }
      return candidates
        .filter((sp) => !route || sp.route === route || sp.name.includes(route))
        .filter((sp) => !status || sp.status === status)
        .filter((sp) => minDurationMs === undefined || sp.durationMs >= minDurationMs)
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, limit);
    },

    async queryMetric({ name, windowMinutes }) {
      const s = catalog.find((x) => x.name === name);
      if (!s) return undefined;
      return { name: s.name, service: s.service, unit: s.unit, description: s.description, points: s.points(windowMinutes) };
    },

    dbDiagnostics,

    async readSource(file) {
      const rel = normalize(file);
      if (!(await listSourceFiles()).includes(rel)) return undefined;
      return { path: rel, content: await readFile(path.join(/* turbopackIgnore: true */ shopfrontDir, rel), "utf8") };
    },

    listSourceFiles,

    gitLog,

    // No deploy pipeline yet; the changes that land on the running store
    // are the /ops flag flips, which Shopfront logs as "ops: ..." warnings.
    async deployHistory({ service, sinceMinutes }) {
      if (service && service !== "shopfront") return [];
      return logs
        .filter((l) => l.service === "shopfront" && l.level === "warn" && l.body.startsWith("ops: "))
        .filter((l) => l.time >= since(sinceMinutes))
        .sort((a, b) => b.time - a.time)
        .map(
          (l): DeployRecord => ({
            service: "shopfront",
            sha: l.attributes["flag.name"] ? `config:${l.attributes["flag.name"]}` : "config",
            deployedAt: new Date(l.time).toISOString(),
            kind: "config",
            message: l.body,
          }),
        );
    },
  };
}

// --- metrics ---------------------------------------------------------------

function minuteBuckets(now: number, windowMinutes: number) {
  const current = Math.floor(now / MINUTE) * MINUTE;
  return Array.from({ length: windowMinutes }, (_, i) => current - (windowMinutes - 1 - i) * MINUTE);
}

function bucketed<T>(rows: T[], timeOf: (r: T) => number, now: number, windowMinutes: number) {
  const starts = minuteBuckets(now, windowMinutes);
  const buckets = new Map<number, T[]>(starts.map((s) => [s, []]));
  for (const r of rows) buckets.get(Math.floor(timeOf(r) / MINUTE) * MINUTE)?.push(r);
  return starts.map((start) => ({ start, rows: buckets.get(start)! }));
}

const point = (start: number, value: number): MetricPoint => ({
  t: new Date(start).toISOString(),
  value: Math.round(value * 100) / 100,
});

// Request metrics computed from Next.js's server spans, since the HTTP
// instrumentation's own histograms don't carry the route. Latency and error
// ratio per route, pages included: a watch rule can trip on any route, and
// its incident charts that route's series.
function spanSeries(
  requests: SpanRow[],
  now: number,
  f: { statusCode: (s: SpanRow) => number; failed: (s: SpanRow) => boolean; duration: (s: SpanRow) => number },
): Series[] {
  const routes = [...new Set(requests.map((r) => String(r.attributes["http.route"])))].sort();
  if (!routes.includes(liveAlert.route)) routes.unshift(liveAlert.route);
  const of = (route: string) => requests.filter((r) => r.attributes["http.route"] === route);

  const latency = (route: string): Series => ({
    name: `http.server.request.duration.p95{route=${route}}`,
    service: "shopfront",
    unit: "ms",
    description: `p95 latency of ${route}, per minute`,
    points: (w) =>
      bucketed(of(route), (r) => r.start, now, w).flatMap(({ start, rows }) =>
        rows.length ? [point(start, p95(rows.map(f.duration)))] : [],
      ),
  });
  const errorRatio = (route: string): Series => ({
    name: `http.server.error_ratio{route=${route}}`,
    service: "shopfront",
    unit: "ratio",
    description: `Share of ${route} responses with status >= 500, per minute`,
    points: (w) =>
      bucketed(of(route), (r) => r.start, now, w).flatMap(({ start, rows }) =>
        rows.length ? [point(start, rows.filter(f.failed).length / rows.length)] : [],
      ),
  });
  return [
    ...routes.map(latency),
    ...routes.map(errorRatio),
    {
      name: "http.server.request.rate",
      service: "shopfront",
      unit: "req/s",
      description: "Requests per second across all routes",
      points: (w) =>
        bucketed(requests, (r) => r.start, now, w).map(({ start, rows }) =>
          point(start, rows.length / Math.max(1, (Math.min(now, start + MINUTE) - start) / 1000)),
        ),
    },
    {
      name: "http.server.error_ratio",
      service: "shopfront",
      unit: "ratio",
      description: "Share of responses with status >= 500",
      points: (w) =>
        bucketed(requests, (r) => r.start, now, w).flatMap(({ start, rows }) =>
          rows.length ? [point(start, rows.filter(f.failed).length / rows.length)] : [],
        ),
    },
  ];
}

// Gauges and sums as exported, one series per distinguishing attribute
// value, e.g. db.client.connection.count{state=used}. Last value per minute.
function metricSeries(rows: MetricRow[], now: number): Series[] {
  const byName = new Map<string, MetricRow[]>();
  for (const r of rows) {
    if (!metricAllowlist(r.name)) continue;
    const list = byName.get(r.name);
    if (list) list.push(r);
    else byName.set(r.name, [r]);
  }
  const poolMax = byName.get("db.client.connection.max")?.at(-1)?.value;

  return [...byName.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([name, points]) => {
      // Attribute keys whose value differs between points label the series.
      const keys = [...new Set(points.flatMap((p) => Object.keys(p.attributes)))].filter(
        (k) => new Set(points.map((p) => String(p.attributes[k]))).size > 1,
      );
      const groups = new Map<string, MetricRow[]>();
      for (const p of points) {
        const label = keys.map((k) => `${k.split(".").at(-1)}=${p.attributes[k]}`).join(",");
        const list = groups.get(label);
        if (list) list.push(p);
        else groups.set(label, [p]);
      }
      const first = points[0];
      const extra = name === "db.client.connection.count" && poolMax ? ` (pool max ${poolMax})` : "";
      return [...groups.entries()].map(
        ([label, group]): Series => ({
          name: label ? `${name}{${label}}` : name,
          service: first.service,
          unit: first.unit.replace(/^\{(.*)\}$/, "$1s").replace(/^1$/, "ratio"),
          description: `${descriptions[name] ?? (first.description || name)}${extra}`,
          points: (w) =>
            bucketed(group, (p) => p.time, now, w).flatMap(({ start, rows }) =>
              rows.length ? [point(start, rows.reduce((a, b) => (b.time >= a.time ? b : a)).value)] : [],
            ),
        }),
      );
    });
}

// Requests waiting for a pooled connection: the most pg-pool.connect spans
// open at once in each minute. instrumentation-pg exports this metric too,
// but only updates it on pool events, which stop once the pool is
// exhausted, so it reads 0 exactly when requests are queueing.
function pendingSeries(connects: SpanRow[], now: number): Series {
  return {
    name: PENDING,
    service: "shopfront",
    unit: "requests",
    description: "Requests waiting for a pg pool connection (peak per minute)",
    points: (w) =>
      minuteBuckets(now, w).map((start) => {
        const end = start + MINUTE;
        const edges = connects
          .filter((s) => s.start < end && s.end > start)
          .flatMap((s) => [
            { t: Math.max(s.start, start), d: 1 },
            { t: Math.min(s.end, end), d: -1 },
          ])
          .sort((a, b) => a.t - b.t || a.d - b.d);
        let open = 0;
        let peak = 0;
        for (const e of edges) peak = Math.max(peak, (open += e.d));
        return point(start, peak);
      }),
  };
}

export function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

// --- logs and spans ----------------------------------------------------------

// Groups records by template: numeric attribute values become <n>, so
// "fetched product" for every product id is one group.
function template(l: LogRow): string {
  const entries = Object.entries(l.attributes);
  if (entries.length === 0) return l.body;
  const fields = entries.map(([k, v]) => `"${k}":${typeof v === "number" ? "<n>" : JSON.stringify(v)}`);
  return `${l.body} {${fields.join(",")}}`;
}

// The span's status message when it has one: instrumentation-pg records a
// generic "PostgreSQL error of type 'Error' occurred" on the exception
// event and puts the real error ("timeout exceeded when trying to
// connect") in the status.
function exceptionMessage(s: SpanRow, eventAttrs: Attrs): string {
  return firstLine(s.statusMessage ?? String(eventAttrs["exception.message"] ?? "unknown error"));
}

function firstLine(s: string): string {
  const line = s.split("\n")[0].trim();
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

function requestRecord(
  r: SpanRow,
  tree: SpanRow[],
  statusCode: (s: SpanRow) => number,
  failed: (s: SpanRow) => boolean,
): SpanRecord {
  const attributes: Attrs = { "http.response.status_code": statusCode(r) };
  if (r.attributes["http.target"]) attributes["url.path"] = r.attributes["http.target"];
  // Time spent waiting for a pooled connection, across the request's queries.
  const connects = tree.filter((s) => s.name === "pg-pool.connect");
  if (connects.length) {
    attributes["db.client.connection.wait_time_ms"] = Math.round(connects.reduce((a, s) => a + (s.end - s.start), 0) * 10) / 10;
  }
  const queries = tree.filter((s) => s.name.startsWith("pg.query"));
  if (queries.length) attributes["db.queries"] = queries.length;
  // The first exception in the request is the cause; later ones wrap it.
  const exception = [r, ...tree]
    .flatMap((s) => s.events.filter((e) => e.name === "exception").map((e) => ({ span: s, e })))
    .sort((a, b) => a.e.time - b.e.time)[0];
  if (exception) {
    attributes["error.type"] = String(exception.e.attributes["exception.type"] ?? "Error");
    attributes["exception.message"] = exceptionMessage(exception.span, exception.e.attributes);
  }
  return {
    traceId: r.traceId,
    service: "shopfront",
    name: r.name,
    route: String(r.attributes["http.route"]),
    startedAt: new Date(r.start).toISOString(),
    durationMs: Math.round((r.end - r.start) * 10) / 10,
    status: failed(r) ? "error" : "ok",
    attributes,
  };
}

// A pg client span, attributed to postgres (the service it calls) and named
// by its query, so the agent can look at the database side by service.
function queryRecord(s: SpanRow): SpanRecord {
  const text = String(s.attributes["db.query.text"] ?? s.name);
  const attributes: Attrs = { "db.system.name": "postgresql" };
  for (const k of ["db.namespace", "db.operation.name"]) if (s.attributes[k] !== undefined) attributes[k] = s.attributes[k];
  return {
    traceId: s.traceId,
    service: "postgres",
    name: text.length > 120 ? `${text.slice(0, 119)}…` : text,
    startedAt: new Date(s.start).toISOString(),
    durationMs: Math.round((s.end - s.start) * 100) / 100,
    status: s.error ? "error" : "ok",
    attributes,
  };
}

// --- database, source, git ---------------------------------------------------

const dbQueries: Record<DbCheck, string> = {
  activity:
    "SELECT pid, application_name, state, to_char(now() - state_change, 'HH24:MI:SS') AS in_state_for, left(query, 60) AS last_query FROM pg_stat_activity WHERE datname = 'shopfront' AND pid <> pg_backend_pid() ORDER BY state_change",
  locks:
    "SELECT pid, pg_blocking_pids(pid)::text AS blocked_by, left(query, 60) AS query FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0",
  slow_queries:
    "SELECT left(query, 60) AS query, calls, round(mean_exec_time::numeric, 2) AS mean_ms, round(max_exec_time::numeric, 2) AS max_ms FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 5",
};

// Its own connection, not the app's pool: it has to work while the app's
// pool is exhausted.
async function dbDiagnostics(check: DbCheck): Promise<DbResult> {
  const query = dbQueries[check];
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3000, application_name: "triage" });
  try {
    await client.connect();
    const { rows } = await client.query(query);
    return { query, rows: rows.map(cells) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { query, rows: [{ error: message }] };
  } finally {
    await client.end().catch(() => {});
  }
}

function cells(row: Record<string, unknown>): Record<string, string | number | null> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, v === null || v === undefined ? null : typeof v === "number" ? v : String(v)]),
  );
}

const sourceExt = /\.(ts|tsx|js|mjs|css|sql|json)$/;
const rootFiles = ["package.json", "next.config.ts", "drizzle.config.ts"];

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(path.join(/* turbopackIgnore: true */ shopfrontDir, dir), { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((e) => {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) return walk(rel);
      return Promise.resolve(sourceExt.test(e.name) ? [rel] : []);
    }),
  );
  return nested.flat();
}

// Shopfront's demo harness: what plants faults, sends synthetic traffic and
// recovers the pool. A customer's app wouldn't have it, and it explains the
// planted bug, so Triage never sees it: read_source can't open it and
// git_log leaves it out. Paths ending in "/" are folders.
export const harnessPaths = [
  "src/app/ops/",
  "src/app/api/ops/",
  "src/lib/ops.ts",
  "src/lib/traffic.ts",
  "src/db/pool-watch.ts",
];
const isHarness = (rel: string) => harnessPaths.some((h) => (h.endsWith("/") ? rel.startsWith(h) : rel === h));

// What read_source may open: the app's code and migrations, never .env or
// the harness.
export async function listSourceFiles(): Promise<string[]> {
  const [src, drizzle] = await Promise.all([walk("src"), walk("drizzle")]);
  return [...rootFiles, ...src, ...drizzle.filter((f) => f.endsWith(".sql"))].filter((f) => !isHarness(f)).sort();
}

const normalize = (p: string) => p.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/^apps\/shopfront\//, "");

const run = promisify(execFile);

// Real history when Shopfront is in a git checkout; none otherwise. Only
// commits that touch Shopfront outside the harness: Triage's own commits
// and the harness's would give the answer away.
export async function gitLog({ path: file, limit }: { path?: string; limit: number }): Promise<CommitRecord[]> {
  const args = ["-C", shopfrontDir, "log", `-n${limit}`, "--name-only", "--format=%x1e%h%x1f%an%x1f%s%x1f%cI", "--relative"];
  args.push("--", file ? normalize(file) : ".", ...harnessPaths.map((h) => `:(exclude)${h}`));
  try {
    const { stdout } = await run("git", args, { timeout: 5000 });
    return stdout
      .split("\x1e")
      .filter((c) => c.trim())
      .map((c) => {
        const [header, ...files] = c.trim().split("\n");
        const [sha, author, message, committedAt] = header.split("\x1f");
        return {
          sha,
          author,
          message,
          committedAt: new Date(committedAt).toISOString(),
          files: files.filter((f) => f && !isHarness(f)),
        };
      });
  } catch {
    return [];
  }
}
