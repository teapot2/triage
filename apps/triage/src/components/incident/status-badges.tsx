import type * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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

const statusColor: Record<IncidentStatus, string> = {
  investigating: "text-warning",
  diagnosed: "text-warning",
  awaiting_approval: "text-warning",
  resolved: "text-success",
  healthy: "text-success",
  failed: "text-destructive",
};

// A ring, the shape every status icon starts from (r 6.25 in a 16 box, so a
// 1.5 stroke stays inside it).
const ring = (props: React.SVGProps<SVGCircleElement>) => (
  <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" {...props} />
);

// The status as a shape, as Linear marks issue status, so it can't be read
// as severity: severity is bars, status is a round icon, and the shape
// alone says which status it is, color only backing it up. The open
// statuses fill the ring as the run gets further: investigating spins,
// diagnosed is half full, awaiting approval (waiting on you) three-quarters.
// Then done: failed is a cross, resolved a check on a tinted disc, healthy
// (nothing to fix) a check in a plain ring. Reduced motion stops the spin.
const statusShape: Record<IncidentStatus, React.ReactNode> = {
  investigating: (
    <>
      {ring({ strokeOpacity: 0.3 })}
      <path d="M8 1.75A6.25 6.25 0 0 1 14.25 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  diagnosed: (
    <>
      {ring({})}
      <path d="M8 4.5A3.5 3.5 0 0 1 8 11.5Z" fill="currentColor" />
    </>
  ),
  awaiting_approval: (
    <>
      {ring({})}
      <path d="M8 4.5A3.5 3.5 0 1 1 4.5 8H8Z" fill="currentColor" />
    </>
  ),
  failed: (
    <>
      {ring({ fill: "currentColor", fillOpacity: 0.2 })}
      <path d="M5.75 5.75l4.5 4.5M10.25 5.75l-4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  resolved: (
    <>
      {ring({ fill: "currentColor", fillOpacity: 0.2 })}
      <path d="M5.25 8.25l1.9 1.9 3.6-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  healthy: (
    <>
      {ring({})}
      <path d="M5.25 8.25l1.9 1.9 3.6-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
};

export function StatusIcon({ status, className }: { status: IncidentStatus; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      role="img"
      aria-label={statusLabel[status]}
      className={cn(
        "size-4 shrink-0",
        statusColor[status],
        status === "investigating" && "animate-spin [animation-duration:1.4s] motion-reduce:animate-none",
        className,
      )}
    >
      {statusShape[status]}
    </svg>
  );
}

export function IncidentStatusBadge({ status }: { status: IncidentStatus }) {
  return (
    <Badge variant="outline" className="gap-1.5">
      <StatusIcon status={status} />
      {statusLabel[status]}
    </Badge>
  );
}

export const severityLabel: Record<Incident["severity"], string> = {
  sev1: "Critical",
  sev2: "High",
  sev3: "Moderate",
  sev4: "Low",
};

// How severe, at a glance: four bars of rising height, like a signal or
// priority meter, filling as severity goes up. Neighbouring levels never
// share a hue: warm for act now (sev1 red, sev2 amber), blue for look when
// you can (sev3), gray for a health check that found nothing (sev4). The
// unfilled bars stay faint so the scale still reads.
const severityLevel: Record<Incident["severity"], { filled: number; color: string }> = {
  sev1: { filled: 4, color: "text-destructive" },
  sev2: { filled: 3, color: "text-warning" },
  sev3: { filled: 2, color: "text-info" },
  sev4: { filled: 1, color: "text-muted-foreground" },
};

export function SeverityBars({ severity, className }: { severity: Incident["severity"]; className?: string }) {
  const { filled, color } = severityLevel[severity];
  return (
    <svg viewBox="0 0 16 14" aria-hidden="true" className={cn("h-3.5 w-4 shrink-0", color, className)}>
      {[4, 7, 10, 13].map((height, i) => (
        <rect
          key={height}
          x={0.5 + i * 4}
          y={14 - height}
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

// The bars alone, for the incident list: hovering them names the level.
// Screen readers get the same name from the label, since the link around the
// row takes focus rather than the bars.
export function SeverityMeter({ severity }: { severity: Incident["severity"] }) {
  const name = `${severity.toUpperCase()} · ${severityLabel[severity]}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span role="img" aria-label={name} className="-m-1 inline-flex shrink-0 p-1">
          <SeverityBars severity={severity} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">{name}</TooltipContent>
    </Tooltip>
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
