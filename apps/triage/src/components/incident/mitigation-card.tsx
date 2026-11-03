"use client";

import { ChevronDownIcon, RotateCcwIcon, ShieldIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { useRegisterCommands } from "@/components/command-registry";
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useChangedSinceMount } from "@/hooks/use-changed-since-mount";
import { isArchived } from "@/lib/investigation/archive";
import { withUnit } from "@/lib/investigation/postmortem/timeline";
import type { Incident, Mitigation } from "@/lib/investigation/schema";
import { cn } from "@/lib/utils";
import { Citations } from "./evidence";
import { formatPercent, formatTime } from "./format";
import { THIS_INCIDENT } from "./incident-commands";
import type { ChartMarker } from "./metric-chart";
import { type Step, StepList } from "./progress-steps";
import { quietMinutes, VerificationLine } from "./verification";
import { errorMessage } from "@/lib/errors";

type MitigationDecision = Extract<Mitigation["state"], "approved" | "denied">;

// Like useApprovalDecision, except the saved state keeps moving after the
// decision (approved, running, applied), so the click only stands in for
// the state it was made over; once the server's state changes, it wins.
function useMitigationDecision(incidentId: string, saved: Mitigation["state"]) {
  const router = useRouter();
  const [optimistic, setOptimistic] = useState<{ decision: MitigationDecision; over: Mitigation["state"] }>();
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: MitigationDecision) {
    setOptimistic({ decision, over: saved });
    setError(null);
    try {
      const res = await fetch(`/api/incidents/${incidentId}/mitigation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (decision === "approved") toast.success("Mitigation approved", { description: "Applying it, then watching the alert's metric." });
      else toast("Mitigation denied", { description: "Nothing is changed; the fix still follows." });
    } catch (err) {
      setOptimistic(undefined);
      setError(errorMessage(err));
    }
    router.refresh();
  }

  const state = optimistic && optimistic.over === saved ? optimistic.decision : saved;
  return { state, decide, error };
}

// Beside a root-cause verdict with nothing to undo, so the page says why
// instead of showing no card.
export function NoMitigationCard({ why, className }: { why: string; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-1 rounded-lg border border-dashed p-4", className)}>
      <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <ShieldIcon className="size-3.5" />
        Mitigation
      </span>
      <p className="font-medium text-sm">No mitigation to propose</p>
      <p className="text-muted-foreground text-sm leading-relaxed">{why}</p>
    </div>
  );
}

// Where to mark the mitigation on the alert chart. recovery.since is on the
// chart's clock; appliedAt is wall time, which on a simulated run falls
// outside the recorded series.
export function mitigationMarker(mitigation: Mitigation | undefined): ChartMarker | undefined {
  if (mitigation?.state !== "applied") return;
  const t = mitigation.recovery?.since ?? mitigation.appliedAt;
  return t ? { t, label: "mitigation applied" } : undefined;
}

// The fast, reversible step before the fix: what it does and why (cited),
// then the approval, its progress, and whether the alert's metric came back.
// `readOnly` on another of the incident's runs than its own: what it would
// propose, with no way to approve it.
export function MitigationCard({ incident, readOnly = false, className }: { incident: Incident; readOnly?: boolean; className?: string }) {
  const mitigation = incident.mitigation!;
  // Archived, the card only reports: nothing to approve, deny or retry.
  const locked = readOnly || isArchived(incident);
  const { state, decide, error } = useMitigationDecision(incident.id, mitigation.state);
  const [confirming, setConfirming] = useState(false);
  useRegisterCommands(
    "incident-mitigation",
    state === "proposed" && !locked
      ? [
          {
            id: "approve-mitigation",
            group: THIS_INCIDENT,
            label: "Approve mitigation",
            icon: ShieldIcon,
            pinned: true,
            run: () => setConfirming(true),
          },
          {
            id: "deny-mitigation",
            group: THIS_INCIDENT,
            label: "Deny mitigation",
            icon: XIcon,
            pinned: true,
            run: () => void decide("denied"),
          },
        ]
      : [],
  );
  const decided = useChangedSinceMount(state);
  const land = decided && "animate-in fade-in-0 duration-200 ease-out motion-reduce:animate-none";
  const recovery = state === "applied" ? mitigation.recovery : undefined;

  return (
    // Closed, the card is the action and where it stands: while proposed,
    // what approving means and the decision; once approved, its steps
    // (applied, recovered, verified), the way a dependency incident's Fix
    // card reads. Why, the steps it runs and the undo open under Details.
    // Approving shows the steps again in its dialog, so they're never
    // approved unseen.
    <Collapsible className={cn("rounded-lg border", className)}>
      <div className="flex flex-col gap-1 p-4">
        {/* The label row is as tall as the label, as on the other cards:
            the buttons beside it hang into the padding rather than push
            the label down. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <ShieldIcon className="size-3.5" aria-hidden />
            Mitigation
          </span>
          <div className="-my-2 ml-auto flex items-center gap-1">
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="group text-muted-foreground">
                Details
                <ChevronDownIcon className="transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
              </Button>
            </CollapsibleTrigger>
            {state === "proposed" && !locked && (
              <>
                <Button variant="ghost" size="sm" onClick={() => void decide("denied")}>
                  Deny
                </Button>
                <Button size="sm" onClick={() => setConfirming(true)}>
                  Approve
                </Button>
              </>
            )}
            {state === "failed" && !locked && (
              <Button variant="outline" size="sm" onClick={() => void decide("approved")}>
                <RotateCcwIcon />
                Retry
              </Button>
            )}
          </div>
        </div>
        <p className="font-medium text-sm">{mitigation.title}</p>
        <div className={cn("pt-1", land)}>
          {state === "proposed" || state === "denied" ? (
            <p className="text-muted-foreground text-xs">{decisionLine(state, mitigation, { readOnly, error })}</p>
          ) : (
            <StepList steps={mitigationSteps(state, mitigation, incident, error)} />
          )}
        </div>
      </div>

      <CollapsibleContent>
        <dl className="grid grid-cols-[4rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 border-t py-3 pr-4 pl-11 text-sm leading-relaxed">
          <dt className="pt-0.5 text-muted-foreground text-xs">Why</dt>
          <dd>
            {mitigation.why.text} <Citations ids={mitigation.why.evidenceIds} />
          </dd>
          <dt className="pt-0.5 text-muted-foreground text-xs">Steps</dt>
          <dd>
            <ol className="list-decimal pl-4">
              {mitigation.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </dd>
          <dt className="pt-0.5 text-muted-foreground text-xs">Undo</dt>
          <dd className="text-muted-foreground">{mitigation.undo}</dd>
          {state === "applied" && mitigation.output && (
            <>
              <dt className="pt-0.5 text-muted-foreground text-xs">Output</dt>
              <dd>
                <code className="break-words font-mono text-muted-foreground text-xs">{mitigation.output}</code>
              </dd>
            </>
          )}
          {recovery?.note && (
            <>
              <dt className="pt-0.5 text-muted-foreground text-xs">Watch</dt>
              <dd className="text-muted-foreground">{recovery.note}</dd>
            </>
          )}
        </dl>
      </CollapsibleContent>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve this mitigation?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-2">
                <p>Triage runs these steps on {incident.service}:</p>
                <ol className="list-decimal pl-5">
                  {mitigation.steps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
                <p>The tested patch still ships separately as the permanent fix.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void decide("approved")}>Approve mitigation</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Collapsible>
  );
}

// The line under the title before anything runs: what approving means
// while it's proposed, or that nothing was changed once denied.
function decisionLine(
  state: "proposed" | "denied",
  mitigation: Mitigation,
  { readOnly, error }: { readOnly: boolean; error: string | null },
): ReactNode {
  if (state === "denied") return "Denied · nothing was changed";
  if (error) return <span className="text-destructive">{error}</span>;
  const n = mitigation.steps.length;
  const facts = `${n} ${n === 1 ? "step" : "steps"} · ${mitigation.risk.replace(/_/g, " ")} risk · reversible`;
  return readOnly ? `${facts} · use the run to approve it` : facts;
}

// "02:06": to the minute, as the chart's axis reads.
const hhmm = (iso: string) => formatTime(iso).slice(0, 5);

// Once approved, where it stands in three steps: applying it, the alert's
// metric coming back under its limit, and the quiet window that resolves
// the incident. The metric is the chart's, just below, so each step gives
// only its value and its time.
function mitigationSteps(state: Mitigation["state"], mitigation: Mitigation, incident: Incident, error: string | null): Step[] {
  const { unit } = incident.trigger;
  const value = (n: number) => (unit === "ratio" ? formatPercent(n) : withUnit(Math.round(n), unit));

  // 1. Applying it on the service.
  let apply: Step;
  if (state === "failed") {
    apply = { title: "Not applied", state: "failed", summary: error ?? mitigation.error ?? "the mitigation failed" };
  } else if (state === "applied") {
    apply = { title: "Applied", state: "done", summary: mitigation.appliedAt && hhmm(mitigation.appliedAt) };
  } else {
    apply = { title: "Applying", state: "current", summary: `on ${incident.service}` };
  }

  // 2. The alert's metric back under its limit, as the recovery watch saw it.
  const recovery = state === "applied" ? mitigation.recovery : undefined;
  let recover: Step;
  if (recovery?.status === "recovered") {
    const last = recovery.series.at(-1)?.value;
    const back = last === undefined ? "back under the limit" : `back to ${value(last)}`;
    recover = { title: "Recovered", state: "done", summary: recovery.recoveredAt ? `${back} at ${hhmm(recovery.recoveredAt)}` : back };
  } else if (recovery?.status === "watching") {
    let under = 0;
    while (under < recovery.series.length && recovery.series.at(-1 - under)!.value < recovery.threshold) under++;
    recover = { title: "Recovering", state: "current", summary: `${under} min under ${value(recovery.threshold)} so far` };
  } else if (recovery) {
    // A note means the watch was cut off (a restart), not that it ran its
    // 5 min; the note itself is under Details.
    recover = { title: "Not recovered", state: "failed", summary: recovery.note ? "the watch stopped" : "still over the limit after 5 min" };
  } else {
    recover = { title: "Recover", state: "todo" };
  }

  // 3. The quiet window that resolves the incident.
  const v = state === "applied" ? incident.verification : undefined;
  let verify: Step;
  if (v?.status === "resolved") {
    const at = incident.resolvedAt ?? v.finishedAt;
    const window = `${quietMinutes(v)} min under ${value(v.threshold)}`;
    verify = { title: "Verified", state: "done", summary: at ? `${window}, resolved ${hhmm(at)}` : window };
  } else if (v?.status === "verifying") {
    verify = { title: "Verifying", state: "current", summary: `${quietMinutes(v)} of ${v.windowMinutes} min under ${value(v.threshold)}` };
  } else if (v) {
    // Breached or stopped: the line says why, with Verify again.
    verify = { title: "Not verified", state: "failed", detail: <VerificationLine incident={incident} verification={v} /> };
  } else if (incident.status === "resolved") {
    verify = { title: "Resolved", state: "done", summary: incident.resolvedAt && hhmm(incident.resolvedAt) };
  } else {
    verify = { title: "Verify", state: "todo" };
  }

  return [apply, recover, verify];
}
