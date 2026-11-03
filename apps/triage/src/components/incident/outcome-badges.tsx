import { CheckIcon, XIcon } from "lucide-react";
import { ResultChip } from "@/components/ui/badge";
import { burnText } from "@/lib/slo/model";
import { formatDuration } from "./format";
import { lowerIsWorse } from "./metric-labels";

// What checks returned, as ResultChips: a test or command, an HTTP status,
// an alert's value against its limit, a log line's level. Small square
// chips, tinted by the outcome; the label beside them stays plain text.

type Tone = "success" | "warning" | "info" | "destructive" | "muted";

// The color an HTTP status gets: 2xx worked, 3xx redirected, 4xx the
// client's fault, 5xx the server's.
export function httpTone(status: number): Tone {
  if (status >= 500) return "destructive";
  if (status >= 400) return "warning";
  if (status >= 300) return "info";
  if (status >= 200) return "success";
  return "muted";
}

// A test or command run: exit 0 passes, anything else fails.
export function TestResultBadge({ exitCode }: { exitCode: number }) {
  const ok = exitCode === 0;
  return (
    <ResultChip tone={ok ? "success" : "destructive"}>
      {ok ? <CheckIcon aria-hidden /> : <XIcon aria-hidden />}
      {ok ? "pass" : "fail"}
    </ResultChip>
  );
}

// An HTTP response, colored by class, with how long it took when known:
// "500", "200 · 42 ms".
export function HttpStatusBadge({ status, latencyMs }: { status: number; latencyMs?: number }) {
  return (
    <ResultChip tone={httpTone(status)}>
      {status}
      {latencyMs !== undefined && <span className="opacity-80">· {formatDuration(latencyMs)}</span>}
    </ResultChip>
  );
}

// A burn rate keeps its tenths ("14.4×"): rounded, an SLO's limit reads 14.
const metricValue = (n: number, unit: string) =>
  unit === "ratio" ? `${Math.round(n * 100)}%` : unit === "×" ? burnText(n) : `${Math.round(n)} ${unit}`;

// An alert's measured value against its limit: the value as a chip, red
// when past the limit (over it, or under it for a metric where less is
// worse) and green when within it, then the limit as plain text.
export function MetricBadges({
  metric,
  observed,
  threshold,
  unit,
}: {
  metric?: string;
  observed: number;
  threshold: number;
  unit: string;
}) {
  // A dependency incident's series is 1 for an audit that found the
  // advisory, 0 once one doesn't: found or not, with no limit to compare.
  if (unit === "advisories") {
    const found = observed >= threshold;
    return <ResultChip tone={found ? "destructive" : "success"}>{found ? "found" : "gone"}</ResultChip>;
  }
  const past = metric && lowerIsWorse(metric) ? observed < threshold : observed > threshold;
  return (
    <span className="inline-flex items-center gap-1.5">
      <ResultChip tone={past ? "destructive" : "success"}>{metricValue(observed, unit)}</ResultChip>
      <span className="text-muted-foreground text-xs tabular-nums">limit {metricValue(threshold, unit)}</span>
    </span>
  );
}

// A log line's level: errors red, warnings amber, the rest quiet.
export function LogLevelBadge({ level, className }: { level: "debug" | "info" | "warn" | "error"; className?: string }) {
  const tone = level === "error" ? "destructive" : level === "warn" ? "warning" : "muted";
  return (
    <ResultChip tone={tone} className={className}>
      {level}
    </ResultChip>
  );
}
