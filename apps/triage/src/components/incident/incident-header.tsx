"use client";

import { CheckCheckIcon, CheckIcon, EllipsisIcon, LoaderCircleIcon, RotateCcwIcon, ShieldCheckIcon, ShieldIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useRegisterCommands } from "@/components/command-registry";
import { ExportMenu } from "@/components/export-menu";
import { StickyHeader } from "@/components/sticky-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Incident } from "@/lib/investigation/schema";
import { ApprovalActions, ApproveDialog, DenyDialog, type NoRerunReason, useApprovalDecision } from "./approval-card";
import { Timestamp } from "@/components/timestamp";
import { THIS_INCIDENT } from "./incident-commands";
import { incidentExports } from "./incident-export";
import { MetricBadges } from "./outcome-badges";
import { IncidentStatusBadge, SeverityBadge } from "./status-badges";
import { quietMinutes, ReopenDialog, reopening, resolutionOptions, useResolution } from "./verification";

// Why a deny with feedback starts no new attempt on this incident, or
// undefined when it does: the client's view of canRerunFix. Only a fix
// proven on the live Shopfront can be written again; a bundled example has
// no run, a recorded scenario's files are fixtures.
export function noRerunReason(incident: Pick<Incident, "run" | "fixRun">): NoRerunReason | undefined {
  if (!incident.run) return "example";
  if (incident.run.source !== "live:shopfront") return "scenario";
  if (incident.fixRun?.status !== "proven") return "unproven";
  return undefined;
}

// The incident at a glance: the title, then one line with its state, where
// and when, and how far past the limit. Once it scrolls away, a compact bar
// keeps the title, status and approval in view.
export function IncidentHeader({ incident }: { incident: Incident }) {
  const { trigger, fix, approval, mitigation, verification } = incident;
  const mitigated = mitigation?.state === "applied";
  const recovered = mitigated && mitigation.recovery?.status === "recovered";
  // Once recovered or being verified, the value now rather than the one
  // that fired the alert. A verification that resolved the incident speaks
  // for it only while it stays resolved: reopened, the alert's value is
  // the one that stands again.
  const verified = verification && (verification.status !== "resolved" || incident.status === "resolved");
  const observed =
    (verified ? verification.series.at(-1)?.value : undefined) ??
    (recovered ? mitigation.recovery?.series.at(-1)?.value : undefined) ??
    trigger.observed;
  // Only a fix Triage proved in its sandbox gets a PR (see canOpenPr).
  const opensPr = incident.fixRun?.status === "proven";
  const { decision, decide, error } = useApprovalDecision(incident.id, approval?.state, opensPr);
  // Each decision goes through one dialog, whether it's asked for from the
  // header, its sticky bar or the search palette: approving confirms,
  // denying asks what the next fix should do differently.
  const [confirming, setConfirming] = useState(false);
  const [denying, setDenying] = useState(false);
  // The same decisions from the search palette, while it's still open.
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
          { id: "deny", group: THIS_INCIDENT, label: "Deny fix", icon: XIcon, pinned: true, run: () => setDenying(true) },
        ]
      : [],
  );
  // Resolving, reopening and verifying again, from a menu beside the
  // approval and from the palette. Reopening asks why, in one dialog.
  const resolution = useResolution(incident);
  const options = resolutionOptions(incident);
  const [reopeningOpen, setReopeningOpen] = useState(false);
  useRegisterCommands("incident-resolution", [
    ...(options.resolve
      ? [{ id: "resolve", group: THIS_INCIDENT, label: "Mark resolved", icon: CheckCheckIcon, keywords: "close done", run: () => void resolution.act("resolve") }]
      : []),
    ...(options.reopen
      ? [{ id: "reopen", group: THIS_INCIDENT, label: "Reopen incident", icon: RotateCcwIcon, run: () => setReopeningOpen(true) }]
      : []),
    ...(options.verify
      ? [{ id: "verify", group: THIS_INCIDENT, label: "Verify again", icon: ShieldCheckIcon, keywords: "check fix worked", run: () => void resolution.act("verify") }]
      : []),
  ]);
  const menu = (options.resolve || options.reopen || options.verify) && (
    <ResolutionMenu
      options={options}
      pending={resolution.pending !== undefined}
      onResolve={() => void resolution.act("resolve")}
      onReopen={() => setReopeningOpen(true)}
      onVerify={() => void resolution.act("verify")}
    />
  );
  const approvalActions = fix && decision && (
    <ApprovalActions
      incidentId={incident.id}
      fix={fix}
      approval={approval}
      decision={decision}
      onApprove={() => setConfirming(true)}
      onDeny={() => setDenying(true)}
      error={error}
    />
  );
  const actions = (approvalActions || menu) && (
    <div className="flex items-center gap-2">
      {approvalActions}
      {menu}
    </div>
  );

  return (
    <>
      <StickyHeader
        title={incident.title}
        status={<IncidentStatusBadge status={incident.status} />}
        actions={actions}
        column="max-w-6xl px-4 sm:px-6"
        className="pt-2 md:pt-8"
      >
        <div className="flex flex-col gap-2 border-b pb-4">
          <nav className="flex items-center gap-1.5 text-muted-foreground text-sm">
            <Link href="/" className="hover:text-foreground">
              Incidents
            </Link>
            <span>/</span>
            <span className="font-mono text-xs">{incident.id}</span>
          </nav>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h1 className="font-heading font-semibold text-2xl tracking-tight">{incident.title}</h1>
            {/* Export stays out of the sticky bar: it's for checking the
                record, not an action to keep in reach. */}
            <div className="flex items-center gap-2">
              {actions}
              <ExportMenu exports={incidentExports(incident)} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-muted-foreground text-sm">
            {/* The badges first (state, severity, value against its limit),
                then where and when, as text. */}
            <IncidentStatusBadge status={incident.status} />
            <SeverityBadge severity={incident.severity} />
            <ProgressBadge incident={incident} mitigated={mitigated} recovered={recovered} />
            <MetricBadges metric={trigger.metric} observed={observed} threshold={trigger.threshold} unit={trigger.unit} />
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
      </StickyHeader>
      <ReopenDialog
        open={reopeningOpen}
        onOpenChange={setReopeningOpen}
        onConfirm={(note) => {
          setReopeningOpen(false);
          void resolution.act("reopen", note);
        }}
      />
      {fix && (
        <>
          <ApproveDialog
            fix={fix}
            opensPr={opensPr}
            mitigated={mitigated}
            open={confirming}
            onOpenChange={setConfirming}
            onConfirm={(dataReviewed) => void decide("approved", undefined, dataReviewed)}
          />
          <DenyDialog
            noRerun={noRerunReason(incident)}
            open={denying}
            onOpenChange={setDenying}
            onConfirm={(feedback) => {
              setDenying(false);
              void decide("denied", feedback);
            }}
          />
        </>
      )}
    </>
  );
}

// How far the incident got after the diagnosis, beside its status: reopened,
// resolved, being verified, recovered or mitigated, the first that holds.
function ProgressBadge({
  incident,
  mitigated,
  recovered,
}: {
  incident: Incident;
  mitigated: boolean;
  recovered: boolean;
}) {
  const { verification, resolvedAt } = incident;
  if (reopening(incident)) {
    return (
      <Badge variant="warning" className="gap-1">
        <RotateCcwIcon />
        Reopened
      </Badge>
    );
  }
  if (incident.status === "resolved" && resolvedAt) {
    return (
      <Timestamp date={resolvedAt} className="hover:no-underline">
        <Badge variant="success" className="gap-1">
          <CheckIcon />
          Resolved
        </Badge>
      </Timestamp>
    );
  }
  if (verification?.status === "verifying") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex cursor-default">
            <Badge variant="secondary" className="gap-1">
              <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
              Verifying
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {quietMinutes(verification)} of {verification.windowMinutes} min under the limit
        </TooltipContent>
      </Tooltip>
    );
  }
  if (!mitigated) return null;
  return (
    <Badge variant="secondary" className="gap-1">
      {recovered ? <CheckIcon /> : <ShieldIcon />}
      {recovered ? "Recovered" : "Mitigated"}
    </Badge>
  );
}

// The incident's other actions, behind one button: resolve it by hand,
// reopen it, or check the fix again. Only what the server would take.
function ResolutionMenu({
  options,
  pending,
  onResolve,
  onReopen,
  onVerify,
}: {
  options: ReturnType<typeof resolutionOptions>;
  pending: boolean;
  onResolve: () => void;
  onReopen: () => void;
  onVerify: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="More actions" disabled={pending}>
          {pending ? <LoaderCircleIcon className="animate-spin" /> : <EllipsisIcon />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {options.resolve && (
          <DropdownMenuItem onSelect={onResolve}>
            <CheckCheckIcon />
            Mark resolved
          </DropdownMenuItem>
        )}
        {options.reopen && (
          <DropdownMenuItem onSelect={onReopen}>
            <RotateCcwIcon />
            Reopen
          </DropdownMenuItem>
        )}
        {options.verify && (
          <DropdownMenuItem onSelect={onVerify}>
            <ShieldCheckIcon />
            Verify again
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
