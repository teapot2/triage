"use client";

import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckCheckIcon,
  CheckIcon,
  EllipsisIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  ShieldIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { useRegisterCommands } from "@/components/command-registry";
import { type ExportSource, ExportSubmenu, useExportCommands } from "@/components/export-menu";
import { StickyHeader } from "@/components/sticky-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNow } from "@/hooks/use-now";
import { archiveBlocker, isArchived } from "@/lib/investigation/archive";
import { currentRun, rerunBlocker } from "@/lib/investigation/reruns";
import { incidentUsage } from "@/lib/investigation/cost";
import type { Incident } from "@/lib/investigation/schema";
import { sourceKind } from "@/lib/investigation/source-kind";
import { ApprovalActions, ApproveDialog, DenyDialog, type NoRerunReason, useApprovalDecision } from "./approval-card";
import { useArchiveActions } from "./archive-actions";
import { Timestamp } from "@/components/timestamp";
import { cn } from "@/lib/utils";
import { formatDateTime } from "./format";
import { THIS_INCIDENT } from "./incident-commands";
import { incidentExports } from "./incident-export";
import { MetricBadges } from "./outcome-badges";
import { RERUN_EVENT, RerunDialog } from "./rerun-dialog";
import { RunPicker, type ShownRun } from "./run-switcher";
import { IncidentStatusBadge, SeverityBadge } from "./status-badges";
import { UsageLine } from "./usage-line";
import { quietMinutes, ReopenDialog, reopening, resolutionOptions, useResolution } from "./verification";

// Why a deny with feedback starts no new attempt on this incident, or
// undefined when it does: the client's view of canRerunFix. Only a fix
// proven on the live Shopfront's own alert can be written again. A bundled
// example has no run, a demo incident's (inc_demo_*, source "demo") fix
// only illustrates the page, and a recorded scenario's files are fixtures.
// An endpoint check on Shopfront gets a proven fix too, but canRerunFix
// takes only live:shopfront, so its feedback starts nothing either; nor
// does a dependency advisory's upgrade's.
export function noRerunReason(incident: Pick<Incident, "run" | "fixRun">): NoRerunReason | undefined {
  const source = incident.run?.source;
  if (!source) return "example";
  if (source === "demo") return "demo";
  switch (sourceKind(incident)) {
    case "live":
      return incident.fixRun?.status === "proven" ? undefined : "unproven";
    case "uptime":
      return "uptime";
    case "dependency":
      return "dependency";
    default:
      // A scenario, including one no longer bundled (sourceKind's undefined).
      return "scenario";
  }
}

// The incident at a glance: the title, then one line with its state, where
// and when, and how far past the limit. Once it scrolls away, a compact bar
// keeps the title, status and approval in view.
// `view` is the run on screen, which a re-run starts from, and `shown` which
// one it is, for the run picker.
export function IncidentHeader({
  incident,
  view = incident,
  shown = currentRun(incident),
}: {
  incident: Incident;
  view?: Incident;
  shown?: ShownRun;
}) {
  const { trigger, fix, approval, mitigation, verification } = incident;
  // An archived incident is read-only: no decisions, here or in the sticky
  // bar, until it's restored (resolutionOptions offers nothing then either).
  const archived = isArchived(incident);
  const dependency = incident.dependency !== undefined;
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
  const usage = incidentUsage(incident);
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
    fix && decision === "pending" && !archived
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
      ? [{ id: "verify", group: THIS_INCIDENT, label: options.verifyLabel, icon: ShieldCheckIcon, keywords: "check fix worked", run: () => void resolution.act("verify") }]
      : []),
  ]);
  const exports = incidentExports(incident);
  // The palette's export commands, whether or not the menu shows them.
  useExportCommands(exports);
  const hasOptions = options.resolve || options.reopen || options.verify;
  // Investigating again with other models: in the header's menu only, not
  // the sticky bar's, since it's not a decision the incident waits on.
  const [rerunning, setRerunning] = useState(false);
  // The clock only decides whether live telemetry has rolled out; it starts
  // at 0 to hydrate, then runs.
  const now = useNow(0);
  const rerunBlocked = rerunBlocker(incident, now);
  // A failed run's notice offers Re-run too (failed-run-notice).
  const canRerun = !rerunBlocked && !archived;
  useEffect(() => {
    if (!canRerun) return;
    const open = () => setRerunning(true);
    window.addEventListener(RERUN_EVENT, open);
    return () => window.removeEventListener(RERUN_EVENT, open);
  }, [canRerun]);
  useRegisterCommands(
    "incident-rerun",
    rerunBlocked || archived
      ? []
      : [{ id: "rerun", group: THIS_INCIDENT, label: "Re-run with other models", icon: RefreshCwIcon, keywords: "again compare model", run: () => setRerunning(true) }],
  );
  // Archiving a closed incident, also from the header's menu only; no
  // confirmation, since the toast offers Undo. Once archived, Restore.
  const archiving = useArchiveActions();
  const archiveBlocked = archived ? undefined : archiveBlocker(incident);
  const archive = () => void archiving.archive([incident.id]);
  const restore = () => void archiving.restore([incident.id]);
  useRegisterCommands(
    "incident-archive",
    archived
      ? [{ id: "restore", group: THIS_INCIDENT, label: "Restore incident", icon: ArchiveRestoreIcon, keywords: "unarchive", run: restore }]
      : archiveBlocked
        ? []
        : [{ id: "archive", group: THIS_INCIDENT, label: "Archive incident", icon: ArchiveIcon, keywords: "hide close", run: archive }],
  );
  // The header's menu has everything; the sticky bar's leaves out export,
  // which is for checking the record, re-run and archive.
  const menuFor = (full: boolean) =>
    (hasOptions || full) && (
      <ResolutionMenu
        options={options}
        exports={full ? exports : []}
        rerun={full && !archived ? { blocked: rerunBlocked, onSelect: () => setRerunning(true) } : undefined}
        archive={full ? { blocked: archiveBlocked, archived, onSelect: archived ? restore : archive } : undefined}
        pending={resolution.pending !== undefined || archiving.pending}
        onResolve={() => void resolution.act("resolve")}
        onReopen={() => setReopeningOpen(true)}
        onVerify={() => void resolution.act("verify")}
      />
    );
  const menu = menuFor(false);
  // Archived, a decision already made still shows; one still pending doesn't.
  const approvalActions = fix && decision && !(archived && decision === "pending") && (
    <ApprovalActions
      incidentId={incident.id}
      fix={fix}
      approval={approval}
      decision={decision}
      opensPr={opensPr}
      archived={archived}
      quietOnceMerged={dependency}
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
  const headerMenu = menuFor(true);
  const headerActions = (
    <div className="flex items-center gap-2">
      {approvalActions}
      {(incident.reruns?.length ?? 0) > 0 && <RunPicker incident={incident} shown={shown} />}
      {headerMenu}
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
            {headerActions}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-muted-foreground text-sm">
            {/* The badges first (state, severity, value against its limit),
                then where and when, as text. */}
            <IncidentStatusBadge status={incident.status} />
            <SeverityBadge severity={incident.severity} />
            <ProgressNote incident={incident} mitigated={mitigated} recovered={recovered} />
            {/* A dependency incident's Fix card says whether the advisory
                is still found: no value against a limit here. */}
            {!dependency && (
              <MetricBadges metric={trigger.metric} observed={observed} threshold={trigger.threshold} unit={trigger.unit} />
            )}
            {/* The dots only separate items on one line; on phones the line
                wraps and they'd dangle at line ends, so spacing does it. */}
            <span className="sm:ml-1">{incident.service}</span>
            <span aria-hidden className="hidden sm:inline">
              ·
            </span>
            <span>
              {incident.openedBy === "watch" ? "Detected by Triage" : "Detected"} <Timestamp date={incident.detectedAt} />
            </span>
            {/* A replay keeps its recording's alert time, which the list
                (sorted by when runs started) doesn't show: say so here. */}
            {incident.run && sourceKind(incident) === "scenario" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className="cursor-default text-muted-foreground">
                    Replay
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>Recorded telemetry, replayed {formatDateTime(incident.run.startedAt)}</TooltipContent>
              </Tooltip>
            )}
            {/* An icon rather than a dot: this is the item that wraps on
                most widths, and a dot would start the new line. */}
            {usage && <UsageLine usage={usage} />}
          </div>
        </div>
      </StickyHeader>
      {!rerunBlocked && !archived && <RerunDialog incident={incident} view={view} open={rerunning} onOpenChange={setRerunning} />}
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
            recovery={recovered ? "recovered" : mitigated ? (mitigation.recovery?.status ?? "watching") : undefined}
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

// How far the incident got after the diagnosis, as a few words after its
// status (the one pill in the row): reopened, being verified, recovered or
// mitigated, the first that holds. Resolved needs nothing more: the status
// says it.
function ProgressNote({
  incident,
  mitigated,
  recovered,
}: {
  incident: Incident;
  mitigated: boolean;
  recovered: boolean;
}) {
  const { verification } = incident;
  const note = "inline-flex items-center gap-1 text-xs";
  if (reopening(incident)) {
    return (
      <span className={cn(note, "text-warning")}>
        <RotateCcwIcon className="size-3.5" aria-hidden />
        Reopened
      </span>
    );
  }
  if (incident.status === "resolved") return null;
  if (verification?.status === "verifying") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn(note, "cursor-default")}>
            <LoaderCircleIcon className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
            Verifying
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {verification.after === "dependencies"
            ? "Waiting for an audit that no longer finds the advisory"
            : `${quietMinutes(verification)} of ${verification.windowMinutes} min under the limit`}
        </TooltipContent>
      </Tooltip>
    );
  }
  if (!mitigated) return null;
  return (
    <span className={cn(note, recovered && "text-success")}>
      {recovered ? <CheckIcon className="size-3.5" aria-hidden /> : <ShieldIcon className="size-3.5" aria-hidden />}
      {recovered ? "Recovered" : "Mitigated"}
    </span>
  );
}

// The incident's other actions, behind one button: re-run it with other
// models, resolve it by hand, reopen it, check the fix again, or archive or
// restore it. Only what the server would take; a re-run or archive that
// can't happen yet shows greyed out, with why under it.
function ResolutionMenu({
  options,
  exports,
  rerun,
  archive,
  pending,
  onResolve,
  onReopen,
  onVerify,
}: {
  options: ReturnType<typeof resolutionOptions>;
  exports: ExportSource[];
  rerun?: { blocked?: string; onSelect: () => void };
  // `archived` makes the item Restore.
  archive?: { blocked?: string; archived: boolean; onSelect: () => void };
  pending: boolean;
  onResolve: () => void;
  onReopen: () => void;
  onVerify: () => void;
}) {
  // The menu's groups, with a rule between each two that show.
  const groups: [string, ReactNode][] = [
    ["rerun", rerun && (
      <DropdownMenuItem onSelect={rerun.onSelect} disabled={Boolean(rerun.blocked)} className="items-start">
        <RefreshCwIcon className="mt-0.5" />
        <span className="flex flex-col gap-0.5">
          Re-run with other models
          {rerun.blocked && <span className="text-muted-foreground text-xs">{rerun.blocked}</span>}
        </span>
      </DropdownMenuItem>
    )],
    ["resolution", (options.resolve || options.reopen || options.verify) && (
      <>
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
            {options.verifyLabel}
          </DropdownMenuItem>
        )}
      </>
    )],
    ["archive", archive &&
      (archive.archived ? (
        <DropdownMenuItem onSelect={archive.onSelect}>
          <ArchiveRestoreIcon />
          Restore
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem onSelect={archive.onSelect} disabled={Boolean(archive.blocked)} className="items-start">
          <ArchiveIcon className="mt-0.5" />
          <span className="flex flex-col gap-0.5">
            Archive
            {archive.blocked && <span className="text-muted-foreground text-xs">{archive.blocked}</span>}
          </span>
        </DropdownMenuItem>
      ))],
    ["export", exports.length > 0 && <ExportSubmenu exports={exports} />],
  ];
  const shown = groups.filter(([, items]) => Boolean(items));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="More actions" disabled={pending}>
          {pending ? <LoaderCircleIcon className="animate-spin" /> : <EllipsisIcon />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={rerun?.blocked || archive?.blocked ? "w-64" : "w-52"}>
        {shown.map(([key, items], i) => (
          <Fragment key={key}>
            {i > 0 && <DropdownMenuSeparator />}
            {items}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
