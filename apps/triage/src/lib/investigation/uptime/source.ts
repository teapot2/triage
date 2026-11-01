import { createLiveSource, shopfrontDir } from "../live/live-source";
import type { MetricPoint } from "../schema";
import type { LogGroup, MetricSeries, SourceDescription, SpanRecord, TelemetrySource } from "../source";
import { checkHost, duration, type UptimeCheck, type UptimeSample } from "./model";

// What an investigation reads for an incident an uptime check opened: the
// check's own results, anchored at the alert. A response-time and an
// availability series, the failures as error logs, one span per check.
// There is nothing else behind an external endpoint, so the database,
// source, git and deploy tools come back empty (and say why: describe()
// carries `external`). A check on Shopfront itself joins its live
// telemetry instead, so the whole pipeline (mitigation, fix) runs.

const MINUTE = 60_000;

export const responseTimeMetric = (check: Pick<UptimeCheck, "id">) => `uptime.response_time{check=${check.id}}`;
export const availabilityMetric = (check: Pick<UptimeCheck, "id">) => `uptime.availability{check=${check.id}}`;

// Read on every call, like the mitigation executors, so a test can set it.
const shopfrontOrigin = () => process.env.SHOPFRONT_URL ?? "http://localhost:3001";

export function targetsShopfront(check: Pick<UptimeCheck, "url">): boolean {
  try {
    return new URL(check.url).origin === new URL(shopfrontOrigin()).origin;
  } catch {
    return false;
  }
}

// A sample's span and the log group it falls in share this, so a log group
// leads to the check that failed last.
const traceIdOf = (check: UptimeCheck, s: UptimeSample) => `${check.id}-${Date.parse(s.at).toString(36)}`;

const failureOf = (s: UptimeSample) => s.error ?? (s.status ? `HTTP ${s.status}` : "no response");

const pathOf = (url: string) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

const round1 = (n: number) => Math.round(n * 10) / 10;

interface Series extends Omit<MetricSeries, "points"> {
  points: (windowMinutes: number) => MetricPoint[];
}

// The check's results as telemetry of `service`: the endpoint's host on its
// own, "shopfront" when they join Shopfront's.
function uptimeTelemetry(check: UptimeCheck, samples: UptimeSample[], now: number, service: string) {
  const seen = samples.filter((s) => Date.parse(s.at) <= now).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const within = (windowMinutes: number) => seen.filter((s) => Date.parse(s.at) > now - windowMinutes * MINUTE);

  const series: Series[] = [
    {
      name: responseTimeMetric(check),
      service,
      unit: "ms",
      description: `Response time of each check of ${check.url}; a failed check is drawn at the ${duration(check.timeoutMs)} timeout`,
      points: (w) => within(w).map((s) => ({ t: s.at, value: s.outcome === "down" ? check.timeoutMs : s.ms })),
    },
    {
      name: availabilityMetric(check),
      service,
      unit: "%",
      description: `Share of checks of ${check.url} that answered in time with an expected status, per minute`,
      // Minutes with no check have no point: nothing was measured.
      points: (w) =>
        [...Map.groupBy(within(w), (s) => Math.floor(Date.parse(s.at) / MINUTE) * MINUTE)].map(([start, inMinute]) => ({
          t: new Date(start).toISOString(),
          value: round1((inMinute.filter((s) => s.outcome === "ok").length / inMinute.length) * 100),
        })),
    },
  ];

  const spans: SpanRecord[] = seen.map((s) => ({
    traceId: traceIdOf(check, s),
    service,
    name: `GET ${check.url}`,
    route: pathOf(check.url),
    startedAt: s.at,
    durationMs: s.ms,
    status: s.outcome === "down" ? "error" : "ok",
    attributes: {
      "url.full": check.url,
      "uptime.outcome": s.outcome,
      ...(s.status !== undefined && { "http.response.status_code": s.status }),
      ...(s.outcome === "down" && { "error.message": failureOf(s) }),
    },
  }));

  return {
    series,

    async queryLogs({ service: wanted, contains, windowMinutes }: Parameters<TelemetrySource["queryLogs"]>[0]) {
      // Every group is level error, so any minLevel lets them through.
      if (wanted && wanted !== service) return [];
      const groups = new Map<string, LogGroup>();
      for (const s of within(windowMinutes)) {
        if (s.outcome !== "down") continue;
        const message = failureOf(s);
        if (contains && !message.toLowerCase().includes(contains.toLowerCase())) continue;
        const g = groups.get(message);
        if (g) {
          g.count++;
          g.lastSeen = s.at;
          g.traceId = traceIdOf(check, s);
        } else {
          groups.set(message, { service, level: "error", message, count: 1, firstSeen: s.at, lastSeen: s.at, traceId: traceIdOf(check, s) });
        }
      }
      return [...groups.values()].sort((a, b) => b.count - a.count);
    },

    async queryTraces({ service: wanted, route, status, minDurationMs, windowMinutes }: Parameters<TelemetrySource["queryTraces"]>[0]) {
      if (wanted && wanted !== service) return [];
      return spans
        .filter((sp) => windowMinutes === undefined || Date.parse(sp.startedAt) > now - windowMinutes * MINUTE)
        .filter((sp) => !route || sp.route === route || sp.name.includes(route))
        .filter((sp) => !status || sp.status === status)
        .filter((sp) => minDurationMs === undefined || sp.durationMs >= minDurationMs);
    },

    queryMetric({ name, windowMinutes }: Parameters<TelemetrySource["queryMetric"]>[0]): MetricSeries | undefined {
      const s = series.find((x) => x.name === name);
      return s && { name: s.name, service: s.service, unit: s.unit, description: s.description, points: s.points(windowMinutes) };
    },
  };
}

// Slowest first, the newest of equals first, as the tool promises.
const slowestFirst = (a: SpanRecord, b: SpanRecord) => b.durationMs - a.durationMs || b.startedAt.localeCompare(a.startedAt);

const catalog = (series: Series[]) => series.map(({ name, service, unit, description }) => ({ name, service, unit, description }));

export interface UptimeSourceOptions {
  // The alert's time; now by default.
  now?: number;
  // Shopfront's live source; tests stub it.
  live?: (opts: { now: number }) => Promise<TelemetrySource>;
}

// `service` is what the incident is filed under: the endpoint's host, or
// "shopfront" when the check targets it. `appDir` is set only then, since
// only Shopfront's code is there to fix.
export async function createUptimeSource(
  check: UptimeCheck,
  samples: UptimeSample[],
  opts: UptimeSourceOptions = {},
): Promise<{ source: TelemetrySource; appDir?: string; service: string }> {
  const now = opts.now ?? Date.now();

  if (targetsShopfront(check)) {
    const live = await (opts.live ?? createLiveSource)({ now });
    const uptime = uptimeTelemetry(check, samples, now, "shopfront");
    const base = live.describe();
    const description: SourceDescription = { ...base, id: `uptime:${check.id}`, metrics: [...base.metrics, ...catalog(uptime.series)] };
    const source: TelemetrySource = {
      describe: () => description,
      dbDiagnostics: (c) => live.dbDiagnostics(c),
      readSource: (p) => live.readSource(p),
      listSourceFiles: () => live.listSourceFiles(),
      gitLog: (q) => live.gitLog(q),
      deployHistory: (q) => live.deployHistory(q),
      async queryMetric(q) {
        return uptime.queryMetric(q) ?? live.queryMetric(q);
      },
      async queryLogs(q) {
        const [own, checks] = await Promise.all([live.queryLogs(q), uptime.queryLogs(q)]);
        return [...own, ...checks].sort((a, b) => b.count - a.count);
      },
      async queryTraces(q) {
        const [own, checks] = await Promise.all([live.queryTraces(q), uptime.queryTraces(q)]);
        return [...own, ...checks].sort(slowestFirst).slice(0, q.limit);
      },
    };
    return { source, appDir: shopfrontDir, service: "shopfront" };
  }

  const service = checkHost(check);
  const uptime = uptimeTelemetry(check, samples, now, service);
  const description: SourceDescription = {
    id: `uptime:${check.id}`,
    now: new Date(now).toISOString(),
    services: [{ name: service, dependsOn: [] }],
    metrics: catalog(uptime.series),
    external: { url: check.url },
  };
  const source: TelemetrySource = {
    describe: () => description,
    queryLogs: uptime.queryLogs,
    async queryTraces(q) {
      return (await uptime.queryTraces(q)).sort(slowestFirst).slice(0, q.limit);
    },
    async queryMetric(q) {
      return uptime.queryMetric(q);
    },
    async dbDiagnostics() {
      return { query: "", rows: [] };
    },
    async readSource() {
      return undefined;
    },
    async listSourceFiles() {
      return [];
    },
    async gitLog() {
      return [];
    },
    async deployHistory() {
      return [];
    },
  };
  return { source, service };
}
