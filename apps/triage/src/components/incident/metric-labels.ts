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
  "db.client.connection.count": "DB pool connections",
  "db.client.connection.pending_requests": "Requests waiting for a DB connection",
  "postgresql.backends": "Postgres backends",
  "postgresql.cpu.utilization": "Postgres CPU",
  // An uptime check's results; the {check=…} label is an id, left off.
  "uptime.response_time": "Response time",
  "uptime.availability": "Availability",
};

// Metrics where less is worse, so an alert on one is under its limit, not
// over it: an uptime check's availability.
export const lowerIsWorse = (metric: string) => metric.startsWith("uptime.availability");

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
  if (labels.state) label = `${label} (${labels.state})`;
  if (labels.route) label = `${label} · ${labels.route}`;
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
