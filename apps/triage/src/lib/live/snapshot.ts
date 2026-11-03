import { p95, requestSamples } from "@/lib/investigation/live/live-source";
import { type LogRow, type MetricRow, readTelemetry, RETENTION_MS, type SpanRow } from "@/lib/investigation/live/otlp-files";
import type { IncidentSummary } from "@/lib/investigation/list-summary";
import type { ChartPoint } from "@/lib/investigation/schema";
import { listIncidentSummaries } from "@/lib/investigation/store";
import { isWatched } from "@/lib/investigation/watch-judge";
import { matchesTarget, readRules, type WatchRule } from "@/lib/investigation/watch-rules";
import { sloBudgets } from "@/lib/slo/budget";
import { liveCounts, rolledThrough, routesSince } from "@/lib/slo/rollups";
import { type LiveRoute, type LiveSlo, type LiveSnapshot, type LiveWindow, liveService, liveWindows } from "./types";

// A service's last few minutes for the live page, summarized here so the
// browser gets a few hundred numbers per poll rather than raw spans. Reads
// the same tailed files as the watch, so polling every couple of seconds
// stays cheap.

// The collector batches for up to 1s and flushes every 1s, so the newest
// couple of seconds are still on their way. Buckets that young would read
// as a dip, so the series stop short of them.
const LAG_MS = 2_000;
// What the tiles summarize: recent enough to follow the traffic, long
// enough that a p95 means something.
const NOW_MS = 30_000;
const FEED_SIZE = 50;

const point = (t: number, value: number | null): ChartPoint => ({ t: new Date(t).toISOString(), value } as ChartPoint);
const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;

// The p95 limit a route is judged on: the first enabled p95 rule that
// covers it. Rules on several routes judge each one, so this is per route.
function p95Limit(rules: WatchRule[], route: string): number | undefined {
  const rule = rules.find((r) => r.enabled && r.condition.metric === "p95" && matchesTarget(r.target, route));
  return rule?.condition.metric === "p95" ? rule.condition.aboveMs : undefined;
}

// The lowest budget left among the SLOs covering a route, if any do.
function budgetOf(slos: LiveSlo[], route: string): Pick<LiveRoute, "budgetLeftPercent"> {
  const left = slos.flatMap((s) => s.routes.filter((r) => r.route === route).map((r) => r.budgetLeftPercent));
  return left.length ? { budgetLeftPercent: Math.min(...left) } : {};
}

export interface SnapshotInput {
  spans: SpanRow[];
  logs: LogRow[];
  metrics: MetricRow[];
  rules: WatchRule[];
  incidents: Pick<IncidentSummary, "id" | "title" | "service" | "detectedAt" | "trigger">[];
  // The SLO rules' budgets (sloSnapshot), when the service has any.
  slos?: LiveSlo[];
}

// Snapshots computed in the last CACHE_MS, per service and window: several
// open tabs, or a tab and its window switch, share one computation.
const CACHE_MS = 1_000;
const cache = new Map<string, { at: number; snapshot: Promise<LiveSnapshot> }>();

export function liveSnapshot(service: string, window: LiveWindow): Promise<LiveSnapshot> {
  const key = `${service}:${window}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.snapshot;
  // Expired entries go, so a page polled once (or a mistyped service name)
  // isn't held for the life of the server.
  for (const [k, v] of cache) if (Date.now() - v.at >= CACHE_MS) cache.delete(k);
  const snapshot = (async () => {
    const [telemetry, rules, incidents] = await Promise.all([readTelemetry(), readRules(), listIncidentSummaries({ service })]);
    const slos = service === liveService ? await sloSnapshot(telemetry.spans, rules) : [];
    return summarize({ ...telemetry, rules, incidents, slos }, service, window, Date.now());
  })();
  cache.set(key, { at: Date.now(), snapshot });
  // A failure isn't kept: the next poll tries again.
  snapshot.catch(() => cache.delete(key));
  return snapshot;
}

// The SLO budgets, read from the request counts, for SLO_CACHE_MS: they
// reach back days and barely move between polls.
const SLO_CACHE_MS = 10_000;
let sloCache: { at: number; key: string; slos: LiveSlo[] } | undefined;

async function sloSnapshot(spans: SpanRow[], rules: WatchRule[]): Promise<LiveSlo[]> {
  const slos = rules.filter((r) => r.enabled && r.condition.metric === "slo");
  if (!slos.length) return [];
  const now = Date.now();
  const key = JSON.stringify(slos);
  if (sloCache && sloCache.key === key && now - sloCache.at < SLO_CACHE_MS) return sloCache.slos;
  // The requests since the counts were last written, or all in the
  // telemetry before any are, as the watch reads them.
  const through = rolledThrough();
  const samples = requestSamples(spans, (through ?? now - RETENTION_MS) - 1, now).filter(isWatched);
  const days = Math.max(...slos.map((r) => (r.condition.metric === "slo" ? r.condition.windowDays : 0)));
  const methods = new Map(routesSince(liveService, now - days * 24 * 3_600_000).map((r) => [r.route, r.method]));
  for (const s of samples) if (s.service === liveService) methods.set(s.route, s.method);
  const routes = [...methods].map(([route, method]) => ({ route, method }));
  const budgets = sloBudgets(slos, routes, liveCounts(liveService, samples, through), now);
  sloCache = { at: now, key, slos: budgets };
  return budgets;
}

// The snapshot itself, from rows already read: no I/O, so it's tested
// directly (snapshot.test.ts).
export function summarize(input: SnapshotInput, service: string, window: LiveWindow, now: number): LiveSnapshot {
  const { ms: windowMs, bucketMs } = liveWindows.find((w) => w.id === window) ?? liveWindows[1];
  // The watch rules judge the live service only, so other services' charts
  // and routes get no limits from them.
  const rules = service === liveService ? input.rules : [];
  const end = Math.floor((now - LAG_MS) / bucketMs) * bucketMs;
  const start = end - windowMs;
  const buckets = Array.from({ length: windowMs / bucketMs }, (_, i) => start + i * bucketMs);
  const bucketOf = (t: number) => Math.floor((t - start) / bucketMs);

  const own = <T extends { service: string }>(rows: T[]) => rows.filter((r) => r.service === service);
  const serviceSpans = own(input.spans);
  const serviceLogs = own(input.logs);
  const serviceMetrics = own(input.metrics);

  // Rows arrive in export batches, roughly but not strictly in time order.
  let lastDataAt = 0;
  for (const s of serviceSpans) lastDataAt = Math.max(lastDataAt, s.end);
  for (const r of [...serviceLogs, ...serviceMetrics]) lastDataAt = Math.max(lastDataAt, r.time);

  // Requests: per bucket for the charts, per route for the table.
  const requests = requestSamples(serviceSpans, start, now).sort((a, b) => a.start - b.start);
  const charted = requests.filter((r) => r.start < end);
  const perBucket = buckets.map(() => [] as typeof requests);
  for (const r of charted) perBucket[bucketOf(r.start)]?.push(r);

  const perSecond = buckets.map((t, i) => point(t, round(perBucket[i].length / (bucketMs / 1000), 2)));
  const p95Ms = buckets.map((t, i) =>
    point(t, perBucket[i].length ? Math.round(p95(perBucket[i].map((r) => r.durationMs))) : null),
  );
  const errorPercent = buckets.map((t, i) =>
    point(t, perBucket[i].length ? round((perBucket[i].filter((r) => r.failed).length / perBucket[i].length) * 100) : null),
  );

  const byRoute = new Map<string, typeof requests>();
  for (const r of charted) {
    const key = `${r.method} ${r.route}`;
    const list = byRoute.get(key);
    if (list) list.push(r);
    else byRoute.set(key, [r]);
  }
  const routes = [...byRoute.values()]
    .map((list): LiveRoute => {
      const { method, route } = list[0];
      return {
        method,
        route,
        requests: list.length,
        perSecond: round(list.length / (windowMs / 1000), 2),
        p95Ms: Math.round(p95(list.map((r) => r.durationMs))),
        errorPercent: round((list.filter((r) => r.failed).length / list.length) * 100),
        limitMs: p95Limit(rules, route),
        ...budgetOf(input.slos ?? [], route),
      };
    })
    .sort((a, b) => b.requests - a.requests);

  // The pool: connections in use as last exported (every 10s, so each
  // bucket carries the latest value forward), and requests waiting, from
  // the pg-pool.connect spans still open in each bucket.
  const used = serviceMetrics
    .filter((m) => m.name === "db.client.connection.count" && m.attributes["db.client.connection.state"] === "used")
    .sort((a, b) => a.time - b.time);
  const poolMax = serviceMetrics.filter((m) => m.name === "db.client.connection.max").at(-1)?.value;
  let latestUsed = used.findLast((m) => m.time < start)?.value;
  let next = used.findIndex((m) => m.time >= start);
  const poolUsed = buckets.map((t) => {
    while (next !== -1 && next < used.length && used[next].time < t + bucketMs) latestUsed = used[next++].value;
    return point(t, latestUsed ?? null);
  });
  const connects = serviceSpans.filter((s) => s.name === "pg-pool.connect" && s.end > start && s.start < end);
  const poolWaiting = buckets.map((t) => {
    const edges = connects
      .filter((s) => s.start < t + bucketMs && s.end > t)
      .flatMap((s) => [
        { at: Math.max(s.start, t), d: 1 },
        { at: Math.min(s.end, t + bucketMs), d: -1 },
      ])
      .sort((a, b) => a.at - b.at || a.d - b.d);
    let open = 0;
    let peak = 0;
    for (const e of edges) peak = Math.max(peak, (open += e.d));
    return point(t, peak);
  });

  const recent = requests.filter((r) => r.start > now - NOW_MS);
  const errorRule = rules.find((r) => r.enabled && r.condition.metric === "errorRate");

  return {
    service,
    window,
    generatedAt: now,
    lastDataAt: lastDataAt || undefined,
    now: {
      perSecond: round(recent.length / (NOW_MS / 1000), 2),
      p95Ms: recent.length ? Math.round(p95(recent.map((r) => r.durationMs))) : undefined,
      errorPercent: recent.length ? round((recent.filter((r) => r.failed).length / recent.length) * 100) : undefined,
      poolUsed: used.at(-1)?.value,
      poolMax,
    },
    overall: {
      perSecond: round(charted.length / (windowMs / 1000), 2),
      p95Ms: charted.length ? Math.round(p95(charted.map((r) => r.durationMs))) : undefined,
      errorPercent: charted.length ? round((charted.filter((r) => r.failed).length / charted.length) * 100) : undefined,
      poolPeak: poolUsed.some((p) => p.value !== null) ? Math.max(...poolUsed.map((p) => p.value ?? 0)) : undefined,
    },
    series: { perSecond, p95Ms, errorPercent, poolUsed, poolWaiting },
    limits: {
      // The API rule's limit: the chart is every route's p95 together, so
      // this is a guide; the table judges each route by its own rule.
      p95Ms: p95Limit(rules, "/api/"),
      errorPercent: errorRule?.condition.metric === "errorRate" ? errorRule.condition.moreThanPercent : undefined,
      poolMax,
    },
    routes,
    slos: input.slos ?? [],
    // Incidents opened on this service in the window, oldest first, to mark
    // on the charts.
    incidents: own(input.incidents)
      .filter((i) => Date.parse(i.detectedAt) >= start && Date.parse(i.detectedAt) <= now)
      .sort((a, b) => Date.parse(a.detectedAt) - Date.parse(b.detectedAt))
      .map((i) => ({ id: i.id, title: i.title, detectedAt: i.detectedAt, rule: i.trigger.rule?.name })),
    requests: requests
      .slice(-FEED_SIZE)
      .reverse()
      .map(({ start, method, route, status, durationMs, failed, traceId }) => ({
        time: start,
        method,
        route,
        status,
        durationMs: Math.round(durationMs),
        failed,
        traceId,
      })),
    logs: serviceLogs
      .filter((l) => l.time > start)
      .sort((a, b) => a.time - b.time)
      .slice(-FEED_SIZE)
      .reverse()
      .map(({ time, level, body, attributes, traceId }) => ({ time, level, body, attributes, traceId })),
  };
}
