"use client";

import { CheckIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRegisterCommands } from "@/components/command-registry";
import type { Incident } from "@/lib/investigation/schema";
import { cn } from "@/lib/utils";
import { ApprovalActions, ApproveDialog, useApprovalDecision } from "./approval-card";
import { Timestamp } from "@/components/timestamp";
import { THIS_INCIDENT } from "./incident-commands";
import { MetricBadges } from "./outcome-badges";
import { IncidentStatusBadge, SeverityBadge } from "./status-badges";

// Height of the sticky bar; the report's section menu sticks below it.
const BAR_HEIGHT = 48;

// The incident at a glance: the title, then one line with its state, where
// and when, and how far past the limit. Once it scrolls away, a compact bar
// keeps the title, status and approval in view.
export function IncidentHeader({ incident }: { incident: Incident }) {
  const { trigger, fix, approval } = incident;
  // Only a fix Triage proved in its sandbox gets a PR (see canOpenPr).
  const opensPr = incident.fixRun?.status === "proven";
  const { decision, decide, error } = useApprovalDecision(incident.id, approval?.state, opensPr);
  // Approving goes through one confirm dialog, whether it's asked for from
  // the header, its sticky bar or the search palette.
  const [confirming, setConfirming] = useState(false);
  // The same decision from the search palette, while it's still open.
  useRegisterCommands(
    "incident-approval",
    fix && decision === "pending"
      ? [
          {
            id: "approve",
            group: THIS_INCIDENT,
            label: "Approve fix",
            icon: CheckIcon,
            hint: `${fix.files.length} files`,
            pinned: true,
            run: () => setConfirming(true),
          },
          { id: "deny", group: THIS_INCIDENT, label: "Deny fix", icon: XIcon, pinned: true, run: () => void decide("denied") },
        ]
      : [],
  );
  const actions = fix && decision && (
    <ApprovalActions
      incidentId={incident.id}
      fix={fix}
      approval={approval}
      decision={decision}
      onApprove={() => setConfirming(true)}
      onDeny={() => void decide("denied")}
      error={error}
    />
  );

  const headerRef = useRef<HTMLElement>(null);
  const [scrolledPast, setScrolledPast] = useState(false);
  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const observer = new IntersectionObserver(
      ([entry]) => setScrolledPast(!entry.isIntersecting && entry.boundingClientRect.top < BAR_HEIGHT),
      { rootMargin: `-${BAR_HEIGHT}px 0px 0px 0px` },
    );
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div className="sticky top-0 z-20 h-0">
        <div
          inert={!scrolledPast}
          aria-hidden={!scrolledPast}
          style={{ height: BAR_HEIGHT }}
          className={cn(
            "absolute inset-x-0 top-0 border-b bg-background/95 backdrop-blur transition-[opacity,translate] duration-200 supports-backdrop-filter:bg-background/80 motion-reduce:transition-none",
            scrolledPast ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-1 opacity-0",
          )}
        >
          <div className="mx-auto flex h-full w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
            <button
              type="button"
              onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
              className="min-w-0 truncate text-left font-medium text-sm hover:text-muted-foreground"
            >
              {incident.title}
            </button>
            <span className="hidden shrink-0 sm:inline-flex">
              <IncidentStatusBadge status={incident.status} />
            </span>
            <div className="ml-auto shrink-0">{actions}</div>
          </div>
        </div>
      </div>

      <header ref={headerRef} className="mx-auto w-full max-w-6xl px-4 pt-2 sm:px-6 md:pt-8">
        <div className="flex flex-col gap-2 border-b pb-6">
          <nav className="flex items-center gap-1.5 text-muted-foreground text-sm">
            <Link href="/" className="hover:text-foreground">
              Incidents
            </Link>
            <span>/</span>
            <span className="font-mono text-xs">{incident.id}</span>
          </nav>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h1 className="font-heading font-semibold text-2xl tracking-tight">{incident.title}</h1>
            {actions}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-muted-foreground text-sm">
            {/* The badges first (state, severity, value against its limit),
                then where and when, as text. */}
            <IncidentStatusBadge status={incident.status} />
            <SeverityBadge severity={incident.severity} />
            <MetricBadges observed={trigger.observed} threshold={trigger.threshold} unit={trigger.unit} />
            {/* The dots only separate items on one line; on phones the line
                wraps and they'd dangle at line ends, so spacing does it. */}
            <span className="sm:ml-1">{incident.service}</span>
            <span aria-hidden className="hidden sm:inline">
              ·
            </span>
            <span>
              {incident.openedBy === "watch" ? "Detected by Triage" : "Detected"} <Timestamp date={incident.detectedAt} />
            </span>
          </div>
        </div>
      </header>
      {fix && (
        <ApproveDialog fix={fix} opensPr={opensPr} open={confirming} onOpenChange={setConfirming} onConfirm={() => void decide("approved")} />
      )}
    </>
  );
}
