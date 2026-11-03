"use client";

import { ChevronRightIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { advisoryLevel, SeverityMark } from "@/components/incident/status-badges";
import { StatusBadge, type StatusTone } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { errorMessage } from "@/lib/errors";
import type { DependencyState, DependencyStatus } from "@/lib/investigation/dependencies";
import type { IncidentStatus } from "@/lib/investigation/schema";
import {
  type AdvisorySeverity,
  type Audit,
  type DependencySettings,
  severityLabel,
  type StoredFinding,
} from "@/lib/investigation/dependencies/model";
import { cn } from "@/lib/utils";

// What the Watch page and an incident share in the browser about the
// dependency audit: its state and findings, polled; Audit now and the
// settings; a severity's mark and a finding's chains. The routes are GET
// and PATCH /api/watch/dependencies and POST /api/watch/dependencies/audit.

export type { DependencyState };

export type DependencyData = {
  state: DependencyState;
  findings: StoredFinding[];
  // The status of the incident each finding opened, by incident id.
  incidents?: Record<string, IncidentStatus>;
  audits: Audit[];
  intervals: number[];
};

// The audit's state and findings, polled every 10 seconds (an audit runs
// hours apart; the poll is for one started elsewhere). `replace` takes a
// fresher state from Audit now or a settings save without waiting.
export function useDependencies() {
  const [data, setData] = useState<DependencyData>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let stopped = false;
    async function load() {
      try {
        const res = await fetch("/api/watch/dependencies", { cache: "no-store" });
        if (stopped) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setData((await res.json()) as DependencyData);
        setError(undefined);
      } catch (err) {
        if (!stopped) setError(errorMessage(err));
      }
    }
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [tick]);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  const replace = useCallback((state: DependencyState) => setData((d) => d && { ...d, state }), []);
  return { data, error, refresh, replace };
}

// Runs an audit now and waits for it (5 to 60 s): the audit, or why not.
// A failed audit is still an answer; its error is on it.
export async function auditNow(): Promise<{ audit?: Audit; state?: DependencyState; error?: string }> {
  try {
    const res = await fetch("/api/watch/dependencies/audit", { method: "POST" });
    const data = (await res.json()) as { audit?: Audit; state?: DependencyState; error?: string };
    return res.ok ? data : { error: data.error ?? `HTTP ${res.status}` };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export type SettingsUpdate = Partial<DependencySettings>;

export async function saveDependencySettings(
  update: SettingsUpdate,
): Promise<{ settings?: DependencySettings; state?: DependencyState; error?: string }> {
  try {
    const res = await fetch("/api/watch/dependencies", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    });
    const data = (await res.json()) as { settings?: DependencySettings; state?: DependencyState; error?: string };
    return res.ok ? data : { error: data.error ?? `HTTP ${res.status}` };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

// --- status ------------------------------------------------------------------

// The audit's states in the rules' and endpoints' words and tones.
export const dependencyStatuses: Record<DependencyStatus, { label: string; tone: StatusTone }> = {
  alerting: { label: "Incident open", tone: "destructive" },
  error: { label: "Audit failed", tone: "destructive" },
  findings: { label: "Advisories", tone: "warning" },
  clean: { label: "No advisories", tone: "success" },
  auditing: { label: "Auditing", tone: "muted" },
  unaudited: { label: "Not audited", tone: "muted" },
  off: { label: "Off", tone: "muted" },
  paused: { label: "Watch paused", tone: "muted" },
};

export function DependencyBadge({ status }: { status: DependencyStatus }) {
  const { label, tone } = dependencyStatuses[status] ?? dependencyStatuses.unaudited;
  return (
    <StatusBadge tone={tone} loading={status === "auditing"} pulse={status === "alerting"}>
      {label}
    </StatusBadge>
  );
}

// --- severity ----------------------------------------------------------------

// An advisory's severity on the app's one scale (status-badges.tsx).
export function AdvisorySeverityBadge({ severity, className }: { severity: AdvisorySeverity; className?: string }) {
  return <SeverityMark level={advisoryLevel(severity)} className={className} />;
}

// "High and above", for the severity floor.
export const floorLabel = (floor: AdvisorySeverity) => (floor === "critical" ? "Critical only" : `${severityLabel(floor)} and above`);

// "Every 6 h", "Every hour".
export const intervalLabel = (hours: number) => (hours === 1 ? "Every hour" : `Every ${hours} h`);

// --- chains ------------------------------------------------------------------

// One chain, "express>body-parser>qs", from the service's own dependency down
// to the vulnerable package, the service's own dependency first and bold.
export function Chain({ chain, className }: { chain: string; className?: string }) {
  const parts = chain.split(">");
  return (
    <span className={cn("flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 font-mono text-xs", className)}>
      {parts.map((p, i) => (
        <span key={i} className="flex items-center gap-x-1">
          {i > 0 && <ChevronRightIcon aria-label="pulls in" className="size-3 shrink-0 text-muted-foreground" />}
          <span className={cn(i === 0 && "font-medium", i === parts.length - 1 && "text-muted-foreground")}>{p}</span>
        </span>
      ))}
    </span>
  );
}

// The shortest chain, and the rest folded under it. The audit sorts them
// shortest first; a package the service depends on itself has a chain of one.
export function Chains({ paths, className }: { paths: string[]; className?: string }) {
  const [first, ...rest] = paths;
  if (!first) return null;
  if (rest.length === 0) return <Chain chain={first} className={className} />;
  return (
    <Collapsible className={cn("group/chains flex flex-col gap-1", className)}>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Chain chain={first} />
        <CollapsibleTrigger className="flex items-center gap-0.5 rounded-sm text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 transition-[rotate] duration-200 group-data-[state=open]/chains:rotate-90 motion-reduce:transition-none"
          />
          {rest.length} more {rest.length === 1 ? "chain" : "chains"}
        </CollapsibleTrigger>
      </span>
      <CollapsibleContent>
        <ul className="flex flex-col gap-1 pt-0.5">
          {rest.map((p) => (
            <li key={p}>
              <Chain chain={p} />
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

// "minimatch@3.0.4, 3.1.1".
export const packageAt = (f: { package: string; versions: string[] }) => `${f.package}@${f.versions.join(", ")}`;

// --- time --------------------------------------------------------------------

// "in 5 h 48 min", "in 3 min", "now".
export function until(iso: string, now: number): string {
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes} min`;
  const h = Math.floor(minutes / 60);
  return `in ${h} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}
