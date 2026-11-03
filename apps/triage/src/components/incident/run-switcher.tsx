"use client";

import {
  ArrowUpFromLineIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  Columns3Icon,
  LayersIcon,
  LoaderCircleIcon,
  XIcon,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { formatCost, incidentUsage } from "@/lib/investigation/cost";
import { isArchived } from "@/lib/investigation/archive";
import { allRuns, currentRun, isRunning, promoteBlocker, runModelsLabel, runView } from "@/lib/investigation/reruns";
import type { Incident, Rerun } from "@/lib/investigation/schema";
import { grade } from "@/lib/investigation/scenarios/grade";
import { getScenario } from "@/lib/investigation/scenarios";
import { rootCauseTitle } from "@/lib/investigation/summary";
import { formatCompact, formatDuration, formatPercent } from "./format";
import { IncidentStatusBadge } from "./status-badges";

export type ShownRun = number | "compare";

// The run the page shows, from the URL (?run=2, or ?run=compare): the
// incident's own run unless another is asked for and exists.
export function useShownRun(incident: Incident): ShownRun {
  const asked = useSearchParams().get("run");
  if (asked === "compare" && incident.reruns?.length) return "compare";
  const n = Number(asked);
  return Number.isInteger(n) && allRuns(incident).some((r) => r.number === n) ? n : currentRun(incident);
}

// Shows a run, or the comparison. The incident's own run is the page
// without ?run, and each run opens on its own Overview (or its live log
// while it runs).
function useSelectRun(incident: Incident) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = currentRun(incident);
  return (value: ShownRun) => {
    const params = new URLSearchParams(searchParams);
    if (value === current) params.delete("run");
    else params.set("run", String(value));
    params.delete("section");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };
}

// Beside Re-run once the incident has more than one run: which run is on
// screen, and a menu of them and their comparison. It stays a quiet button
// on the run in use, and turns amber on any other, where RunNotice says why.
export function RunPicker({ incident, shown }: { incident: Incident; shown: ShownRun }) {
  const select = useSelectRun(incident);
  const runs = allRuns(incident);
  const current = currentRun(incident);
  const away = shown !== current;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn("border border-border", away && "border-warning/50 text-warning hover:text-warning")}
        >
          {shown === "compare" ? <Columns3Icon /> : <LayersIcon />}
          {shown === "compare" ? "Comparing runs" : `Run ${shown} of ${runs.length}`}
          <ChevronDownIcon className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        {runs.map((r) => (
          <DropdownMenuItem key={r.number} onSelect={() => select(r.number)} className={cn(r.number === shown && "bg-muted")}>
            <CheckIcon className={cn(r.number !== shown && "invisible")} />
            <span className="shrink-0 whitespace-nowrap">Run {r.number}</span>
            {r.number === current && (
              <span className="text-muted-foreground text-xs">· in use</span>
            )}
            {isRunning(r) && <LoaderCircleIcon className="animate-spin text-muted-foreground" />}
            <span title={runModelsLabel(r)} className="ml-auto min-w-0 truncate font-mono text-muted-foreground text-xs">
              {runModelsLabel(r)}
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => select("compare")} className={cn(shown === "compare" && "bg-muted")}>
          <Columns3Icon />
          Compare runs
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Above the report only while it shows something other than the run in
// use: what's on screen, the way back, and the way to make it the
// incident's run.
export function RunNotice({ incident, shown }: { incident: Incident; shown: ShownRun }) {
  const select = useSelectRun(incident);
  const current = currentRun(incident);
  if (shown === current) return null;
  const run = shown === "compare" ? undefined : allRuns(incident).find((r) => r.number === shown);
  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 border-warning/60 border-l-2 py-0.5 pl-3 text-muted-foreground text-sm">
      <p className="min-w-0 flex-1">
        {run ? (
          <>
            Viewing run {run.number}, <span className="font-mono text-foreground text-xs">{runModelsLabel(run)}</span>.{" "}
            {isRunning(run)
              ? "It's still running, and acts on nothing and notifies no one."
              : "Its mitigation and fix are shown, not carried out, until you use it."}
          </>
        ) : (
          <>Every run of this incident on the same telemetry. Run {current} is the one in use.</>
        )}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => select(current)}>
          Back to run {current}
        </Button>
        {run && !isArchived(incident) && <PromoteButton incident={incident} number={run.number} />}
      </div>
    </div>
  );
}

// Makes the run the incident's own, after a confirmation; when it can't be,
// the button explains why in a popover.
function PromoteButton({ incident, number }: { incident: Incident; number: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const blocked = promoteBlocker(incident, number);
  const current = currentRun(incident);

  async function promote() {
    setPending(true);
    try {
      const res = await fetch(`/api/incidents/${incident.id}/reruns/${number}/promote`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      toast.success(`Run ${number} is now the incident's run`, { description: `Run ${current} stays beside it.` });
      router.replace(pathname, { scroll: false });
      router.refresh();
    } catch (err) {
      toast.error("Couldn't use this run", { description: errorMessage(err) });
    } finally {
      setPending(false);
      setConfirming(false);
    }
  }

  if (blocked) {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" aria-disabled className="text-muted-foreground">
            <ArrowUpFromLineIcon />
            Use this run
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 text-sm">
          <p className="font-medium">Can&apos;t use run {number}</p>
          <p className="mt-1 text-muted-foreground">{blocked}</p>
        </PopoverContent>
      </Popover>
    );
  }
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setConfirming(true)} disabled={pending}>
        {pending ? <LoaderCircleIcon className="animate-spin" /> : <ArrowUpFromLineIcon />}
        Use this run
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Use run {number}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its diagnosis becomes the incident&apos;s: its mitigation and fix wait for your approval, and a postmortem you write
              uses it and its model. Run {current} stays beside it, and questions already asked stay on the incident.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void promote()}>Use run {number}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// The runs side by side: what each concluded, what it would do, and what it
// took. On a recorded scenario, whether each matched the known answer.
export function RunComparison({ incident }: { incident: Incident }) {
  const select = useSelectRun(incident);
  const current = currentRun(incident);
  const runs = allRuns(incident).map((r) => ({ r, view: runView(incident, r.number)! }));
  const scenario = incident.run?.source.startsWith("scenario:") ? getScenario(incident.run.source.slice("scenario:".length)) : undefined;
  const expected = scenario?.expected;

  const rows: { label: string; cell: (r: Rerun, view: Incident) => React.ReactNode }[] = [
    { label: "Models", cell: (r) => <span className="font-mono text-xs">{runModelsLabel(r)}</span> },
    { label: "Status", cell: (r) => <IncidentStatusBadge status={r.status} /> },
    { label: "Verdict", cell: (_, view) => verdictText(view) },
    {
      label: "Confidence",
      cell: (_, view) => {
        const v = view.report?.verdict;
        const leading = v?.kind === "root_cause" ? view.report?.hypotheses.find((h) => h.id === v.hypothesisId) : undefined;
        return leading ? formatPercent(leading.confidence) : "—";
      },
    },
    ...(expected
      ? [
          {
            label: "Matches the known cause",
            cell: (_: Rerun, view: Incident) => {
              if (!view.report) return "—";
              const g = grade(view.report, view.mitigation, expected, view.evidence);
              return (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex cursor-default items-center gap-1">
                      {g.hit ? <CheckIcon className="size-3.5 text-success" /> : <XIcon className="size-3.5 text-destructive" />}
                      {g.hit ? "Yes" : "No"}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-72">{g.reasons.join("; ")}</TooltipContent>
                </Tooltip>
              );
            },
          },
        ]
      : []),
    { label: "Mitigation", cell: (_, view) => view.mitigation?.title ?? "None proposed" },
    { label: "Fix", cell: (r) => fixText(r) },
    { label: "Evidence", cell: (_, view) => `${view.evidence.length} items, ${view.steps.length} tool calls` },
    { label: "Model steps", cell: (r) => r.run?.modelSteps ?? "—" },
    {
      label: "Duration",
      cell: (r) => (r.run?.finishedAt ? formatDuration(Date.parse(r.run.finishedAt) - Date.parse(r.run.startedAt)) : "—"),
    },
    {
      label: "Tokens",
      cell: (_, view) => {
        const u = usageOf(view);
        return u ? formatCompact(u.tokens.inputTokens + u.tokens.outputTokens) : "—";
      },
    },
    {
      label: "Cost",
      cell: (_, view) => {
        const u = usageOf(view);
        return u?.cost !== undefined ? formatCost(u.cost) : "—";
      },
    },
  ];

  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-40" />
            {runs.map(({ r }) => (
              <TableHead key={r.number} className="min-w-48">
                <button type="button" onClick={() => select(r.number)} className="flex items-center gap-1.5 hover:underline">
                  Run {r.number}
                  {r.number === current && (
                    <span className="text-muted-foreground text-xs">· in use</span>
                  )}
                  {isRunning(r) && <LoaderCircleIcon className="size-3.5 animate-spin text-muted-foreground" />}
                </button>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.label}>
              <TableCell className="align-top text-muted-foreground text-xs">{row.label}</TableCell>
              {runs.map(({ r, view }) => (
                <TableCell key={r.number} className="whitespace-normal align-top text-sm">
                  {row.cell(r, view)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// What a run concluded, in a few words.
function verdictText(view: Incident): React.ReactNode {
  if (view.status === "investigating") return <span className="text-muted-foreground">Investigating…</span>;
  const verdict = view.report?.verdict;
  if (!verdict) {
    return (
      <span className="inline-flex items-center gap-1 text-destructive">
        <CircleAlertIcon className="size-3.5" />
        {view.run?.error ? "Failed" : "No report"}
      </span>
    );
  }
  if (verdict.kind === "healthy") return "Healthy: no fault behind the alert";
  if (verdict.kind === "inconclusive") return "Inconclusive";
  return rootCauseTitle(view) ?? "Root cause";
}

function fixText(r: Rerun): string {
  switch (r.fixRun?.status) {
    case undefined:
      return "—";
    case "writing":
    case "testing":
      return "Writing and proving…";
    case "proven":
      return r.fix ? `Proven: ${r.fix.summary}` : "Proven";
    case "declined":
      return "Declined: not a code defect";
    default:
      return "Failed";
  }
}

// What the run itself used: its investigation and fix, not the incident's
// questions or postmortem.
const usageOf = (view: Incident) => incidentUsage({ ...view, questions: undefined, postmortem: undefined });
