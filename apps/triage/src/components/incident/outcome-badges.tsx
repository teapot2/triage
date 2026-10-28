import { Badge } from "@/components/ui/badge";
import { formatDuration } from "./format";

type Tone = "success" | "warning" | "info" | "destructive" | "secondary";

// The color an HTTP status gets: 2xx worked, 3xx redirected, 4xx the
// client's fault, 5xx the server's.
export function httpTone(status: number): Tone {
  if (status >= 500) return "destructive";
  if (status >= 400) return "warning";
  if (status >= 300) return "info";
  if (status >= 200) return "success";
  return "secondary";
}

// A test or command run: exit 0 passes, anything else fails.
export function TestResultBadge({ exitCode }: { exitCode: number }) {
  const ok = exitCode === 0;
  return <Badge variant={ok ? "success" : "destructive"}>{ok ? "passes" : "fails"}</Badge>;
}

// An HTTP response, colored by class, with how long it took when known:
// "500", "200 · 42 ms".
export function HttpStatusBadge({ status, latencyMs }: { status: number; latencyMs?: number }) {
  return (
    <Badge variant={httpTone(status)} className="font-mono tabular-nums">
      {status}
      {latencyMs !== undefined && <span className="font-sans opacity-80">· {formatDuration(latencyMs)}</span>}
    </Badge>
  );
}

const metricValue = (n: number, unit: string) =>
  unit === "ratio" ? `${Math.round(n * 100)}%` : `${Math.round(n)} ${unit}`;

// An alert's measured value against its limit, as a pair like the test
// results: the value red when over the limit (green when within it), then
// the limit itself, quiet.
export function MetricBadges({ observed, threshold, unit }: { observed: number; threshold: number; unit: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge variant={observed > threshold ? "destructive" : "success"} className="tabular-nums">
        {metricValue(observed, unit)}
      </Badge>
      <Badge variant="secondary" className="font-normal tabular-nums">
        limit {metricValue(threshold, unit)}
      </Badge>
    </span>
  );
}

// A log line's level: errors red, warnings amber, the rest quiet.
export function LogLevelBadge({ level }: { level: "debug" | "info" | "warn" | "error" }) {
  const variant = level === "error" ? "destructive" : level === "warn" ? "warning" : "secondary";
  return <Badge variant={variant}>{level}</Badge>;
}
