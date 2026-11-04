import type { Evidence } from "@/lib/investigation/schema";

// Readable names for the metrics the tools return, e.g.
// "http.server.request.duration.p95{route=/api/products/[id]}" ->
// "p95 latency · /api/products/[id]". The raw name stays in the evidence
// panel for anyone who needs it.
const known: Record<string, string> = {
  "http.server.request.duration": "latency",
  "http.server.duration": "latency",
  "http.server.request.rate": "Request rate",
  "http.server.error_ratio": "Error rate",
  // A slow-request rule's: the requests in a minute slower than {le=…} ms,
  // as a count or a share (watch-rule-model's slowMetric).
  "http.server.slow_requests": "Slow requests",
  "http.server.slow_share": "Share of slow requests",
  // An SLO's; its {objective=…} and {le=…} labels are left off.
  "slo.burn_rate": "Error budget burn",
  "db.client.connection.count": "DB pool connections",
  "db.client.connection.pending_requests": "Requests waiting for a DB connection",
  "postgresql.backends": "Postgres backends",
  "postgresql.cpu.utilization": "Postgres CPU",
  // An uptime check's results; the {check=…} label is an id, left off.
  "uptime.response_time": "Response time",
  "uptime.availability": "Availability",
  // The dependency audit's: 1 per audit that found the {advisory=…}.
  vulnerable_dependencies: "Advisory found",
};

// Metrics where less is worse, so an alert on one is under its limit, not
// over it: an uptime check's availability.
export const lowerIsWorse = (metric: string) => metric.startsWith("uptime.availability");

// Metrics whose limit is "more than N", as the slow-request rules say it:
// a minute at the limit is healthy, one past it breaches. Every other
// metric breaches at its limit.
export const exclusiveLimit = (metric: string) =>
  metric.startsWith("http.server.slow_requests") || metric.startsWith("http.server.slow_share");

// Whether a value of the metric is past its alert limit: over it for a
// "more than N" metric, at or over it for the rest, or under it where less
// is worse (an uptime check's availability, alerting under 100 %).
export function pastLimit(metric: string, threshold: number): (value: number) => boolean {
  if (lowerIsWorse(metric)) return (v) => v < threshold;
  return exclusiveLimit(metric) ? (v) => v > threshold : (v) => v >= threshold;
}

// Which side of its limit a metric is healthy on, in words: "under" the
// limit for latency and errors, "at or under" it for a "more than N"
// count, "at or over" it for availability; and the side a breach is on.
// "5 min under the limit", "Back over the limit".
export const limitSides = (metric: string) =>
  lowerIsWorse(metric)
    ? { healthy: "at or over", breach: "under" }
    : exclusiveLimit(metric)
      ? { healthy: "at or under", breach: "over" }
      : { healthy: "under", breach: "over" };

// The limit as a rule states it, from its value already formatted: "more
// than 3 requests" for a "more than N" metric, the value alone otherwise.
export const limitText = (metric: string, formatted: string) =>
  exclusiveLimit(metric) ? `more than ${formatted}` : formatted;

export function metricLabel(metric: string): string {
  const parts = metric.match(/^([^{]+)(?:\{(.*)\})?$/);
  const base = (parts?.[1] ?? metric).trim();
  const labels: Record<string, string> = Object.fromEntries(
    (parts?.[2] ?? "")
      .split(",")
      .filter(Boolean)
      .map((pair) => pair.split("=").map((s) => s.trim())),
  );

  // A trailing percentile, as ".p95" or " p95".
  const pct = base.match(/^(.*?)[. ](p\d{2,3})$/);
  const name = pct ? pct[1] : base;
  const percentile = pct?.[2];
  let label = known[name] ?? humanize(name);
  if (percentile) label = `${percentile} ${label}`;
  // "Requests over 1500 ms", "Share of requests over 1500 ms": the slow
  // limit is what they're counted on.
  if (labels.le && exclusiveLimit(name)) {
    label = `${name.endsWith("share") ? "Share of requests" : "Requests"} over ${labels.le} ms`;
  }
  if (labels.state) label = `${label} (${labels.state})`;
  if (labels.route) label = `${label} · ${labels.route}`;
  if (labels.advisory) label = `${label} · ${labels.advisory}`;
  return label;
}

// "postgresql.cache_hit_ratio" -> "Cache hit ratio"
function humanize(name: string): string {
  const last = name.split(".").slice(-2).join(" ").replace(/_/g, " ");
  return last.charAt(0).toUpperCase() + last.slice(1);
}

// The one line to show for an evidence item. Tools write metric summaries
// starting with the raw metric name; those get the readable name and rounded
// numbers instead. Summaries written by hand are kept as they are.
export function evidenceTitle(e: Evidence): string {
  if (e.kind !== "metric" || !e.summary.startsWith(e.metric)) return e.summary;
  return `${metricLabel(e.metric)}: ${round(e.baseline)} → ${round(e.observed)} ${e.unit}`;
}

function round(n: number): string {
  return Math.abs(n) >= 100 ? String(Math.round(n)) : String(Number(n.toFixed(2)));
}
