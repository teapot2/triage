import { Badge } from "@/components/ui/badge";
import type { Incident, IncidentStatus } from "@/lib/investigation/schema";
import { cn } from "@/lib/utils";

export const statusLabel: Record<IncidentStatus, string> = {
  investigating: "Investigating",
  diagnosed: "Diagnosed",
  awaiting_approval: "Awaiting approval",
  resolved: "Resolved",
  healthy: "Healthy",
  failed: "Failed",
};

// Investigating is live: a ring ripples out from the solid dot, the usual
// "something is running" signal. Reduced motion keeps just the dot.
const statusDot: Record<IncidentStatus, string> = {
  investigating:
    "relative bg-warning before:absolute before:inset-0 before:animate-ping before:rounded-full before:bg-warning motion-reduce:before:animate-none",
  diagnosed: "bg-warning",
  awaiting_approval: "bg-warning",
  resolved: "bg-success",
  healthy: "bg-success",
  failed: "bg-destructive",
};

export function StatusDot({ status, className }: { status: IncidentStatus; className?: string }) {
  return <span className={cn("size-1.5 shrink-0 rounded-full", statusDot[status], className)} />;
}

export function IncidentStatusBadge({ status }: { status: IncidentStatus }) {
  return (
    <Badge variant="outline" className="gap-1.5">
      <StatusDot status={status} />
      {statusLabel[status]}
    </Badge>
  );
}

// How severe, at a glance: three bars of rising height, like a signal or
// priority meter, filling and warming as severity goes up. sev1 fills all
// three in red, sev2 two in amber, sev3 one in blue; the rest stay faint so
// the scale still reads. Decorative: the badge beside it says the severity.
const severityLevel: Record<Incident["severity"], { filled: number; color: string }> = {
  sev1: { filled: 3, color: "text-destructive" },
  sev2: { filled: 2, color: "text-warning" },
  sev3: { filled: 1, color: "text-info" },
};

export function SeverityBars({ severity, className }: { severity: Incident["severity"]; className?: string }) {
  const { filled, color } = severityLevel[severity];
  return (
    <svg viewBox="0 0 14 14" aria-hidden="true" className={cn("size-3.5 shrink-0", color, className)}>
      {[4, 8, 12].map((height, i) => (
        <rect
          key={height}
          x={1 + i * 4.5}
          y={13 - height}
          width={3}
          height={height}
          rx={1}
          fill="currentColor"
          className={i < filled ? undefined : "text-muted-foreground opacity-30"}
        />
      ))}
    </svg>
  );
}

export function SeverityBadge({ severity }: { severity: Incident["severity"] }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <SeverityBars severity={severity} />
      <Badge variant={severity === "sev1" ? "destructive" : "secondary"} className="font-mono uppercase">
        {severity}
      </Badge>
    </span>
  );
}
