import type * as React from "react";
import { useId } from "react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Incident, IncidentStatus } from "@/lib/investigation/schema";
import { cn } from "@/lib/utils";

export const statusLabel: Record<IncidentStatus, string> = {
  investigating: "Investigating",
  diagnosed: "Diagnosed",
  awaiting_approval: "Awaiting approval",
  resolved: "Resolved",
  healthy: "No issue found",
  failed: "Failed",
};

const statusColor: Record<IncidentStatus, string> = {
  investigating: "text-warning",
  diagnosed: "text-warning",
  awaiting_approval: "text-warning",
  resolved: "text-success",
  healthy: "text-muted-foreground",
  failed: "text-destructive",
};

// Where a status sits in the run: still going, or an outcome. Filter menus
// list statuses under these headings, in this order.
export const statusGroups: { label: string; statuses: IncidentStatus[] }[] = [
  { label: "In progress", statuses: ["investigating", "diagnosed", "awaiting_approval"] },
  { label: "Done", statuses: ["resolved", "failed", "healthy"] },
];
export const statusGroupOf = Object.fromEntries(
  statusGroups.flatMap((g) => g.statuses.map((s) => [s, g.label])),
) as Record<IncidentStatus, string>;

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
// Then done: failed is a cross, resolved (a fix shipped) a solid disc with
// the check cut out, and healthy (nothing to fix, the most common outcome)
// a gray check in a dashed ring, so it recedes next to real incidents.
// Reduced motion stops the spin.
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
  // Drawn by StatusIcon, which needs an id for the check's cutout.
  resolved: null,
  healthy: (
    <>
      {/* 12 dashes around the ring (circumference 39.27), so no seam. */}
      {ring({ strokeDasharray: "1.8 1.4725" })}
      <path d="M5.25 8.25l1.9 1.9 3.6-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
};

// Resolved: a solid disc with the check masked out, so the check shows
// whatever is behind the icon (a hovered row, a menu, a badge).
function ResolvedShape() {
  const mask = useId();
  return (
    <>
      <mask id={mask}>
        <rect width="16" height="16" fill="white" />
        <path d="M5.25 8.25l1.9 1.9 3.6-4" fill="none" stroke="black" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      </mask>
      <circle cx="8" cy="8" r="7" fill="currentColor" mask={`url(#${mask})`} />
    </>
  );
}

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
      {status === "resolved" ? <ResolvedShape /> : statusShape[status]}
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

// How severe, on one scale for incidents and dependency advisories: four
// bars of rising height, like a signal or priority meter, filling as
// severity goes up, each level in its own hue (red, orange, amber, gray) so
// neighbours never look alike. An incident's sev1 to sev4 read as Critical
// to Low, the same words an advisory uses. The unfilled bars stay faint so
// the scale still reads.
export type SeverityLevel = "critical" | "high" | "moderate" | "low";

const levelStyle: Record<SeverityLevel, { filled: number; color: string }> = {
  critical: { filled: 4, color: "text-destructive" },
  high: { filled: 3, color: "text-high" },
  moderate: { filled: 2, color: "text-warning" },
  low: { filled: 1, color: "text-muted-foreground" },
};

export const severityLevel: Record<Incident["severity"], SeverityLevel> = {
  sev1: "critical",
  sev2: "high",
  sev3: "moderate",
  sev4: "low",
};

// An advisory's severity on the same scale: info sits with low.
export const advisoryLevel = (s: "info" | "low" | "moderate" | "high" | "critical"): SeverityLevel => (s === "info" ? "low" : s);

const levelWords: Record<SeverityLevel, string> = { critical: "Critical", high: "High", moderate: "Moderate", low: "Low" };

// The word's color. In light mode it's the hue mixed toward black, as the
// tinted badges do: orange and amber text at their own lightness fail
// contrast on white. The bars keep the plain hue.
const wordColor: Record<SeverityLevel, string> = {
  critical: "text-[color-mix(in_oklab,var(--destructive)_80%,black)] dark:text-destructive",
  high: "text-[color-mix(in_oklab,var(--high)_70%,black)] dark:text-high",
  moderate: "text-[color-mix(in_oklab,var(--warning)_55%,black)] dark:text-warning",
  low: "text-muted-foreground",
};

export function SeverityBars({
  severity,
  level = severity && severityLevel[severity],
  className,
}: {
  severity?: Incident["severity"];
  level?: SeverityLevel;
  className?: string;
}) {
  const { filled, color } = levelStyle[level ?? "low"];
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
  const name = `${severityLabel[severity]} · ${severity.toUpperCase()}`;
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

// Severity with its word, where there's room: the bars and "High" in the
// level's hue, no pill around them (a pill is a status's shape). `hint`
// adds a tooltip, an incident's "SEV2" say.
export function SeverityMark({ level, hint, className }: { level: SeverityLevel; hint?: string; className?: string }) {
  const mark = (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 font-medium text-xs", wordColor[level], className)}>
      <SeverityBars level={level} />
      {levelWords[level]}
    </span>
  );
  if (!hint) return mark;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-default">{mark}</span>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

// An incident's severity as a SeverityMark, its sev number on hover.
export function SeverityBadge({ severity }: { severity: Incident["severity"] }) {
  return <SeverityMark level={severityLevel[severity]} hint={severity.toUpperCase()} />;
}
