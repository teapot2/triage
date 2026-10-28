import type { ChartPoint } from "@/lib/investigation/schema";

// What the live service page shows, summarized on the server from the
// collector's files (see snapshot.ts). No server imports, so the page's
// client components can use the types and the window options.

export const liveWindows = [
  { id: "1m", label: "1m", ms: 60_000, bucketMs: 2_000 },
  { id: "5m", label: "5m", ms: 5 * 60_000, bucketMs: 5_000 },
  { id: "15m", label: "15m", ms: 15 * 60_000, bucketMs: 15_000 },
] as const;
export type LiveWindow = (typeof liveWindows)[number]["id"];

export interface LiveRoute {
  method: string;
  route: string;
  requests: number;
  perSecond: number;
  p95Ms: number;
  errorPercent: number;
  // The p95 limit of the watch rule that judges this route, if one does.
  limitMs?: number;
}

export interface LiveIncident {
  id: string;
  title: string;
  detectedAt: string;
  // The watch rule that opened it; undefined when a person did.
  rule?: string;
}

export interface LiveRequest {
  time: number;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  failed: boolean;
  traceId: string;
}

export interface LiveLog {
  time: number;
  level: "debug" | "info" | "warn" | "error";
  body: string;
  traceId?: string;
}

export interface LiveSnapshot {
  service: string;
  window: LiveWindow;
  generatedAt: number;
  // The newest telemetry of any kind from the service; undefined when there
  // is none in the files at all.
  lastDataAt?: number;
  // Over the last NOW_MS, so the tiles move with the traffic.
  now: {
    perSecond: number;
    p95Ms?: number;
    errorPercent?: number;
    poolUsed?: number;
    poolMax?: number;
  };
  // One point per bucket across the whole window; null where there was
  // nothing to measure (no requests, no pool reading yet).
  series: {
    perSecond: ChartPoint[];
    p95Ms: ChartPoint[];
    errorPercent: ChartPoint[];
    poolUsed: ChartPoint[];
    // Peak requests waiting for a pool connection.
    poolWaiting: ChartPoint[];
  };
  // Limits from the enabled watch rules, drawn on the charts.
  limits: { p95Ms?: number; errorPercent?: number; poolMax?: number };
  routes: LiveRoute[];
  incidents: LiveIncident[];
  requests: LiveRequest[];
  logs: LiveLog[];
}

// One request's spans, for the trace view (trace.ts).
export interface LiveTraceSpan {
  spanId: string;
  name: string;
  service: string;
  depth: number;
  // From the trace's first span.
  offsetMs: number;
  durationMs: number;
  error: boolean;
  statusMessage?: string;
  // What it queried or served: the SQL, the route.
  detail?: string;
}

export interface LiveTrace {
  traceId: string;
  start: number;
  durationMs: number;
  spans: LiveTraceSpan[];
  // More spans than the view shows.
  truncated: boolean;
}
