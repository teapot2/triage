import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import type { MetricPoint } from "../schema";
import {
  type CommitRecord,
  type DbCheck,
  type DbResult,
  type DeployRecord,
  deriveFlagStates,
  type FlagEvent,
  flagEventFromMessage,
  flagsFromAttributes,
  type LogGroup,
  slowQueriesNote,
  type SourceDescription,
  type SpanRecord,
  type TelemetrySource,
} from "../source";
import { type Attrs, type LogRow, type MetricRow, readTelemetry, type SpanRow } from "./otlp-files";
import { errorMessage } from "../../errors";

// The running Shopfront, read from what it really emitted: OTLP spans, logs
// and metrics from the collector's files, Postgres itself for diagnostics,
// and the app's source tree. The telemetry is snapshotted when the source is
// created (the alert time), so every query in one investigation sees the
// same data. Diagnostics and source reads are live.

export const shopfrontDir = path.resolve(
  /* turbopackIgnore: true */ process.env.SHOPFRONT_DIR ??
    path.join(/* turbopackIgnore: true */ process.cwd(), "..", "shopfront"),
);
export const shopfrontDatabaseUrl =
  process.env.SHOPFRONT_DATABASE_URL ?? "postgres://triage:triage@localhost:5433/shopfront";

// Triage's own statements on the watched database end in this comment, so
// db_diagnostics can leave them out: pg_stat_statements keeps the text it
// first saw for a statement, comments and all. Postgres groups statements by
// their parse tree, not their text, so only ones the app never runs (the
// sandbox's copy, these diagnostics) may carry it; a tagged BEGIN would hide
// the app's own BEGINs.
const ownQueryTag = "/* triage */";
export const ownQuery = (sql: string) => `${sql} ${ownQueryTag}`;
// The connections Triage opens to the watched database.
export const triageApplicationNames = ["triage", "triage-sandbox"] as const;

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
  // Looked up on the first git_log, not here: most reads of the source (the
  // watch, the recovery) never ask for history.
  const release = once(() => fetchRelease());

  const description: SourceDescription = {
    id: "live:shopfront",
    now: new Date(now).toISOString(),
    services,
    metrics: catalog.map(({ name, service, unit, description }) => ({ name, service, unit, description })),
    // From every log kept, not a window: the boot line that names each
    // flag may be hours older than the alert.
    flags: flagStates(logs),
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

    async queryTraces({ service, route, status, minDurationMs, windowMinutes, limit }) {
      const candidates: SpanRecord[] = [];
      if (!service || service === "shopfront") {
        for (const r of requests) candidates.push(requestRecord(r, subtree(r), statusCode, failed));
      }
      if (!service || service === "postgres") {
        for (const s of spans) if (s.attributes["db.system.name"] === "postgresql" && s.name.startsWith("pg.query")) candidates.push(queryRecord(s));
      }
      return candidates
        .filter((sp) => windowMinutes === undefined || Date.parse(sp.startedAt) >= since(windowMinutes))
        .filter((sp) => !route || sp.route === route || sp.name.includes(route))
        .filter((sp) => !status || sp.status === status)
        .filter((sp) => minDurationMs === undefined || sp.durationMs >= minDurationMs)
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, limit);
    },

    async queryMetric({ name, windowMinutes }) {
      const s = catalog.find((x) => x.name === name) ?? burnSeries(name, requests, now, { failed, duration });
      if (!s) return undefined;
      return { name: s.name, service: s.service, unit: s.unit, description: s.description, points: s.points(windowMinutes) };
    },

    dbDiagnostics: (check) => dbDiagnostics(check, now),

    async readSource(file) {
      const rel = normalize(file);
      if (!(await listSourceFiles()).includes(rel)) return undefined;
      return { path: rel, content: await readFile(path.join(/* turbopackIgnore: true */ shopfrontDir, rel), "utf8") };
    },

    listSourceFiles,

    // History from the deployed release when one is on the store, so the
    // commit the deploy history names is there to read; HEAD's otherwise.
    async gitLog(q) {
      return gitLog({ ...q, from: (await release())?.sha });
    },

    async deployHistory({ service, sinceMinutes }) {
      if (service && service !== "shopfront") return [];
      return deployRecords(logs.filter((l) => l.time >= since(sinceMinutes)));
    },
  };
}

// The flag events in Shopfront's logs: the `flags: loaded` it logs at boot,
// with a `flag.FF_X` attribute per flag, and the `ops: FF_X turned on|off`
// warning the ops API logs on each flip.
export function flagEvents(logs: LogRow[]): FlagEvent[] {
  return logs.flatMap((l): FlagEvent[] => {
    if (l.service !== "shopfront") return [];
    if (l.body.startsWith("flags: loaded")) return [{ at: l.time, kind: "loaded", flags: flagsFromAttributes(l.attributes) }];
    const flip = flagEventFromMessage(l.body, l.time);
    return flip ? [flip] : [];
  });
}

// The flags' states at the end of these logs (deriveFlagStates).
export function flagStates(logs: LogRow[]): Record<string, boolean> {
  return deriveFlagStates(flagEvents(logs));
}

// What changed on the running store, newest first, from what Shopfront logs
// as warnings: a release deployed or rolled back by its release harness
// ("deploy: ...") and the /ops flag flips ("ops: ..."), which stand in for
// the config pushes a real flag system logs.
export function deployRecords(logs: LogRow[]): DeployRecord[] {
  return logs
    .filter((l) => l.service === "shopfront" && l.level === "warn" && (l.body.startsWith("ops: ") || l.body.startsWith("deploy: ")))
    .sort((a, b) => b.time - a.time)
    .map((l): DeployRecord => {
      const deployedAt = new Date(l.time).toISOString();
      if (l.body.startsWith("ops: ")) {
        return {
          service: "shopfront",
          sha: l.attributes["flag.name"] ? `config:${l.attributes["flag.name"]}` : "config",
          deployedAt,
          kind: "config",
          message: l.body,
        };
      }
      const a = l.attributes;
      const rollback = a["deploy.kind"] === "rollback";
      return {
        service: "shopfront",
        sha: String(a["deploy.sha"] ?? "unknown"),
        deployedAt,
        kind: rollback ? "rollback" : "deploy",
        message: rollback ? l.body : String(a["deploy.message"] ?? l.body.slice("deploy: ".length)),
        ...(typeof a["deploy.branch"] === "string" && a["deploy.branch"] ? { branch: a["deploy.branch"] } : {}),
      };
    });
}

// --- the deployed release --------------------------------------------------

export const shopfrontUrl = process.env.SHOPFRONT_URL ?? "http://localhost:3001";

// A release Shopfront's harness has deployed into the running store, as its
// ops API reports it.
export interface Release {
  name: string;
  sha: string;
  branch: string;
  message: string;
  deployedAt: string;
  // HEAD's short sha, what the store ran before the release.
  previous: string;
}

// The release deployed right now, or undefined when none is (or the ops API
// is off, unreachable, or slow): the source then reads as if there were no
// release harness. Read once per source, so one investigation sees one
// release throughout.
export async function fetchRelease(fetchImpl: typeof fetch = fetch, url = `${shopfrontUrl}/api/ops`): Promise<Release | undefined> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return undefined;
    const { release } = (await res.json()) as { release?: Release | null };
    return release && typeof release.sha === "string" && release.sha ? release : undefined;
  } catch {
    return undefined;
  }
}

function once<T>(f: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= f());
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

// An SLO's burn rate on a route (watch-rule-model's burnMetric), what its
// incident charts: per minute, the share of requests in the 5 minutes to the
// minute's end that weren't good, against the share the objective allows.
// Built when asked for, from the objective and latency in the name.
const burnName = /^slo\.burn_rate\{route=(\/[^,}]*),objective=([\d.]+)(?:,le=(\d+))?\}$/;
const BURN_WINDOW = 5 * MINUTE;

export function burnSeries(
  name: string,
  requests: SpanRow[],
  now: number,
  f: { failed: (s: SpanRow) => boolean; duration: (s: SpanRow) => number },
): Series | undefined {
  const m = name.match(burnName);
  if (!m) return undefined;
  const [, route, objective, le] = m;
  const allowed = 1 - Number(objective) / 100;
  if (!(allowed > 0)) return undefined;
  const latencyMs = le === undefined ? undefined : Number(le);
  const rows = requests.filter((r) => routeOf(r) === route);
  const bad = (r: SpanRow) => f.failed(r) || (latencyMs !== undefined && f.duration(r) > latencyMs);
  return {
    name,
    service: "shopfront",
    unit: "×",
    description: `How fast ${route} spends its error budget (${objective}% of requests succeeding${latencyMs === undefined ? "" : ` within ${latencyMs} ms`}): 1 spends exactly the budget, per minute over the 5 minutes to its end`,
    points: (w) =>
      minuteBuckets(now, w).flatMap((start) => {
        const end = start + MINUTE;
        const inWindow = rows.filter((r) => r.start >= end - BURN_WINDOW && r.start < end);
        return inWindow.length ? [point(start, inWindow.filter(bad).length / inWindow.length / allowed)] : [];
      }),
  };
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

const triageConnections = triageApplicationNames.map((n) => `'${n}'`).join(", ");

export const dbQueries: Record<DbCheck, string> = {
  // Triage's own connections (these diagnostics, the sandbox copying the
  // database) aren't the app's.
  activity: `SELECT pid, application_name, state, to_char(now() - state_change, 'HH24:MI:SS') AS in_state_for, left(query, 60) AS last_query FROM pg_stat_activity WHERE datname = 'shopfront' AND pid <> pg_backend_pid() AND application_name NOT IN (${triageConnections}) ORDER BY state_change`,
  locks:
    "SELECT pid, pg_blocking_pids(pid)::text AS blocked_by, left(query, 60) AS query FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0",
  // Only this database's statements: the sandbox proves fixes in throwaway
  // copies on the same server, and their test queries would otherwise crowd
  // the app's own out of the top five. Nor Triage's own: copying a big table
  // for every fix run would top the list and be cited as the app's slow
  // query. One-off statements (a seed, creating and dropping the copies)
  // can't be what slows a route either, so the list keeps to statements run
  // at least ten times.
  // The fifty by total, with the id and total the window is counted from
  // (windowedSlowQueries picks the five to show and drops those two).
  slow_queries: `SELECT queryid::text AS id, left(query, 60) AS query, calls, round(mean_exec_time::numeric, 2) AS mean_ms, round(max_exec_time::numeric, 2) AS max_ms, round(total_exec_time::numeric, 2) AS total_ms FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) AND query NOT LIKE '%${ownQueryTag}%' AND query NOT LIKE '%pg_stat_statements%' AND query NOT ILIKE 'CREATE DATABASE%' AND query NOT ILIKE 'DROP DATABASE%' AND calls >= 10 ORDER BY total_exec_time DESC LIMIT 50`,
};

// pg_stat_statements counts since the server's statistics were last reset,
// so a statement that ran hours before the alert (the fix sandbox copying a
// table, a seed) can top slow_queries during an alert it had nothing to do
// with, and runs have cited it as the cause. The watch samples the counters
// every SAMPLE_EVERY (sampleStatements), kept for SAMPLES_KEPT, and
// slow_queries counts each statement's calls and time since the sample
// SLOW_WINDOW before the alert beside its totals (windowedSlowQueries). On
// globalThis: one list per server process, across dev hot reloads.
export type StatementSample = { at: number; stats: Map<string, { calls: number; totalMs: number }> };
const SAMPLE_EVERY = 30_000;
const SAMPLES_KEPT = 3 * 60 * MINUTE;
export const SLOW_WINDOW = 15 * MINUTE;
const samplesGlobal = globalThis as unknown as { triageStatementSamples?: StatementSample[] };
const statementSamples = () => (samplesGlobal.triageStatementSamples ??= []);

export async function sampleStatements(at = Date.now()): Promise<void> {
  const list = statementSamples();
  if (list.length && at - list.at(-1)!.at < SAMPLE_EVERY) return;
  const client = new Client({ connectionString: shopfrontDatabaseUrl, connectionTimeoutMillis: 3000, application_name: "triage" });
  try {
    await client.connect();
    const { rows } = await client.query<{ id: string; calls: string; total_ms: string }>(
      ownQuery(
        "SELECT queryid::text AS id, calls, total_exec_time AS total_ms FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())",
      ),
    );
    list.push({ at, stats: new Map(rows.map((r) => [r.id, { calls: Number(r.calls), totalMs: Number(r.total_ms) }])) });
    while (list.length && list[0].at < at - SAMPLES_KEPT) list.shift();
  } catch {
    // No database to reach, or no pg_stat_statements: slow_queries says so.
  } finally {
    await client.end().catch(() => {});
  }
}

// The sample to count the window from: the latest taken SLOW_WINDOW or more
// before `now`, else the oldest at least a minute before it (the watch has
// just started), else none.
export function baselineSample(now: number, list = statementSamples()): StatementSample | undefined {
  const kept = list.filter((s) => s.at >= now - SAMPLES_KEPT && s.at <= now - MINUTE);
  return [...kept].reverse().find((s) => s.at <= now - SLOW_WINDOW) ?? kept[0];
}

type SlowRow = Record<string, string | number | null>;

// The slow_queries rows as reported: the five with the most time in the
// window, each with its calls and time there beside its totals, or the
// five by total when there is no sample to count from. A counter below the
// sample's (the statistics were reset since) counts as nothing.
export function windowedSlowQueries(query: string, rows: SlowRow[], baseline: StatementSample | undefined, now: number): DbResult {
  const shown = (r: SlowRow) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "id" && k !== "total_ms"));
  if (!baseline) return { query, rows: rows.slice(0, 5).map(shown), note: slowQueriesNote(now, undefined) };
  const windowed = rows
    .map((r) => {
      const before = baseline.stats.get(String(r.id));
      const calls = Math.max(0, Number(r.calls) - (before?.calls ?? 0));
      const ms = Math.max(0, Number(r.total_ms) - (before?.totalMs ?? 0));
      return { ...shown(r), window_calls: calls, window_ms: Math.round(ms * 100) / 100 };
    })
    .sort((a, b) => b.window_ms - a.window_ms || b.window_calls - a.window_calls)
    .slice(0, 5);
  return { query, rows: windowed, note: slowQueriesNote(now, Math.round((now - baseline.at) / MINUTE)) };
}

// Its own connection, not the app's pool: it has to work while the app's
// pool is exhausted.
async function dbDiagnostics(check: DbCheck, now = Date.now()): Promise<DbResult> {
  const query = dbQueries[check];
  const client = new Client({ connectionString: shopfrontDatabaseUrl, connectionTimeoutMillis: 3000, application_name: "triage" });
  try {
    await client.connect();
    const { rows } = await client.query(ownQuery(query));
    const plain = rows.map(cells);
    return check === "slow_queries" ? windowedSlowQueries(query, plain, baselineSample(now), now) : { query, rows: plain };
  } catch (err) {
    const message = errorMessage(err);
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
  "src/lib/traffic-profile.ts",
  "src/db/pool-watch.ts",
  "scripts/shoppers.ts",
  // The release harness: what deploys a commit's diff into the running
  // store and rolls it back.
  "src/lib/releases.ts",
  "releases/",
  "scripts/release.ts",
];
// A harness file's test is harness too: traffic-profile.test.ts spells out
// the rushes the profile sends.
const isHarness = (rel: string) => {
  const plain = rel.replace(/\.test\.(tsx?)$/, ".$1");
  return harnessPaths.some((h) => (h.endsWith("/") ? rel.startsWith(h) : plain === h));
};

// What read_source may open: the app's code and migrations, never .env or
// the harness.
export async function listSourceFiles(): Promise<string[]> {
  const [src, drizzle] = await Promise.all([walk("src"), walk("drizzle")]);
  return [...rootFiles, ...src, ...drizzle.filter((f) => f.endsWith(".sql"))].filter((f) => !isHarness(f)).sort();
}

export const normalize = (p: string) => p.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/^apps\/shopfront\//, "");

const run = promisify(execFile);

export interface GitLogQuery {
  path?: string;
  limit: number;
  // The commit to log from, when not HEAD: the deployed release's.
  from?: string;
  // Each commit's diff instead of only its file names.
  patch?: boolean;
}

// The git command behind gitLog, as its arguments. With `patch`, the
// pathspec keeps the harness's hunks out of the diffs as well.
export function gitLogArgs({ path: file, limit, from, patch }: GitLogQuery): string[] {
  const args = ["-C", shopfrontDir, "log", `-n${limit}`, patch ? "--patch" : "--name-only", "--format=%x1e%h%x1f%an%x1f%s%x1f%cI", "--relative"];
  if (from) args.push(from);
  args.push("--", file ? normalize(file) : ".", ...harnessPaths.map((h) => `:(exclude)${h}`));
  return args;
}

const diffFile = /^diff --git a\/(\S+) b\//gm;

// Real history when Shopfront is in a git checkout; none otherwise. Only
// commits that touch Shopfront outside the harness: Triage's own commits
// and the harness's would give the answer away.
export async function gitLog(q: GitLogQuery): Promise<CommitRecord[]> {
  try {
    // A whole history's diffs run to a few hundred KB.
    const { stdout } = await run("git", gitLogArgs(q), q.patch ? { timeout: 20_000, maxBuffer: 64 * 1024 * 1024 } : { timeout: 5000 });
    return stdout
      .split("\x1e")
      .filter((c) => c.trim())
      .map((c) => {
        const [header, ...rest] = c.trim().split("\n");
        const [sha, author, message, committedAt] = header.split("\x1f");
        const record = { sha, author, message, committedAt: new Date(committedAt).toISOString() };
        if (!q.patch) return { ...record, files: rest.filter((f) => f && !isHarness(f)) };
        const patch = rest.join("\n").trim();
        return { ...record, files: [...patch.matchAll(diffFile)].map((m) => m[1]).filter((f) => !isHarness(f)), patch };
      });
  } catch {
    return [];
  }
}
