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
import { sourceKind } from "@/lib/investigation/source-kind";
import { burnText } from "@/lib/slo/model";
import type { Incident, Mitigation } from "@/lib/investigation/schema";
import { cn } from "@/lib/utils";
import { Citations } from "./evidence";
import { formatPercent, formatTime } from "./format";
import { limitSides, pastLimit } from "./metric-labels";
import { THIS_INCIDENT } from "./incident-commands";
import type { ChartMarker } from "./metric-chart";
import { type Step, StepList } from "./progress-steps";
import {
  quietMinutes,
  reopenedSinceVerified,
  reopenedWords,
  resolutionOptions,
  VerificationLine,
  VerifyButton,
} from "./verification";
import { errorMessage } from "@/lib/errors";

type MitigationDecision = Extract<Mitigation["state"], "approved" | "denied">;

// Like useApprovalDecision, except the saved state keeps moving after the
// decision (approved, running, applied), so the click only stands in for
// the state it was made over; once the server's state changes, it wins.
function useMitigationDecision(incident: Incident, saved: Mitigation["state"]) {
  const router = useRouter();
  const [optimistic, setOptimistic] = useState<{ decision: MitigationDecision; over: Mitigation["state"] }>();
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: MitigationDecision) {
    setOptimistic({ decision, over: saved });
    setError(null);
    try {
      const res = await fetch(`/api/incidents/${incident.id}/mitigation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (decision === "approved") toast.success("Mitigation approved", { description: "Applying it, then watching the alert's metric." });
      else toast("Mitigation denied", { description: permanentFix(incident).denied });
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
  const { state, decide, error } = useMitigationDecision(incident, mitigation.state);
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
            <StepList steps={mitigationSteps(state, mitigation, incident, error, locked)} />
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
                <p>
                  {simulated(incident)
                    ? `This is a recorded incident, so Triage simulates these steps and nothing on ${incident.service} changes:`
                    : `Triage runs these steps on ${incident.service}:`}
                </p>
                <ol className="list-decimal pl-5">
                  {mitigation.steps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
                <p>{permanentFix(incident).approving}</p>
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

// The permanent fix beside the mitigation, as far as the fix stage has got:
// for the approve dialog, and for the deny toast. The fix stage may still be
// writing, may have declined or failed, and a bundled example may have none.
export function permanentFix(incident: Pick<Incident, "fix" | "fixRun" | "approval" | "run">): { approving: string; denied: string } {
  const { fix, fixRun, approval } = incident;
  if (fixRun?.status === "writing" || fixRun?.status === "testing") {
    return {
      approving: "A fix is being written and proven separately as the permanent fix.",
      denied: "Nothing is changed; a fix is still being written.",
    };
  }
  if (fix) {
    const proven = fixRun?.status === "proven" ? "proven fix" : "fix";
    if (approval?.state === "approved") {
      return {
        approving: `The approved ${proven} ships separately as the permanent fix.`,
        denied: "Nothing is changed; the approved fix still ships.",
      };
    }
    if (approval?.state === "denied") {
      return { approving: `The ${proven} was denied, so this is the only change for now.`, denied: "Nothing is changed." };
    }
    return {
      approving: `A ${proven} waits for approval separately as the permanent fix.`,
      denied: "Nothing is changed; the fix still waits for approval.",
    };
  }
  if (fixRun?.status === "failed") return { approving: "No fix could be proven, so this is the only change for now.", denied: "Nothing is changed." };
  // Declined, or no fix stage: on a run, it may not have started yet.
  const none = fixRun || !incident.run ? "No code fix was proposed" : "No code fix has been proposed yet";
  return { approving: `${none}, so this is the only change for now.`, denied: "Nothing is changed." };
}

// Why the recovery watch ended without a recovery, in a few words. The
// full note is under Details. No note: it ran its course over the limit,
// for `watchedMs` (5 min, 10 for a burn rate: recovery's recoveryDeadline).
export function notRecoveredWhy(note: string | undefined, watchedMs?: number): string {
  if (!note) {
    return watchedMs === undefined ? "still past the limit" : `still past the limit after ${Math.max(1, Math.round(watchedMs / 60_000))} min`;
  }
  if (/^the watch stopped/i.test(note)) return "the watch stopped";
  if (/^no requests/i.test(note)) return "no requests since the mitigation";
  const line = note.trim().split("\n")[0].replace(/\.$/, "");
  return line.charAt(0).toLowerCase() + line.slice(1);
}

// "02:06": to the minute, as the chart's axis reads.
const hhmm = (iso: string) => formatTime(iso).slice(0, 5);

// Only a run on the service itself changes it: live Shopfront, or an
// endpoint check on it (executorFor picks the executor the same way; an
// external check's mitigation fails rather than pretend). Scenarios and
// examples replay a recorded recovery.
const simulated = (incident: Incident) => {
  const kind = sourceKind(incident);
  return kind !== "live" && kind !== "uptime";
};

// Once approved, where it stands in three steps: applying it, the alert's
// metric coming back under its limit, and the quiet window that resolves
// the incident. The metric is the chart's, just below, so each step gives
// only its value and its time.
function mitigationSteps(
  state: Mitigation["state"],
  mitigation: Mitigation,
  incident: Incident,
  error: string | null,
  locked: boolean,
): Step[] {
  const { unit, metric } = incident.trigger;
  // Burn rates as the verification card and the SLO pages write them ("83.3×").
  const value = (n: number) =>
    unit === "ratio" ? formatPercent(n) : unit === "×" ? burnText(n) : withUnit(Math.round(n), unit);
  // "under 500 ms" for latency, "at or under 3 requests" for a count of
  // slow requests, "at or over 100%" for availability.
  const sides = limitSides(metric);
  const healthy = (n: number, limit: number) => !pastLimit(metric, limit)(n);
  // A verification asked for from the card, when the route would take one.
  const verifyAction = (label: string) =>
    !locked && resolutionOptions(incident).verify ? (
      <div className="flex">
        <VerifyButton incident={incident}>{label}</VerifyButton>
      </div>
    ) : undefined;

  // 1. Applying it on the service.
  let apply: Step;
  if (state === "failed") {
    apply = { title: "Not applied", state: "failed", summary: error ?? mitigation.error ?? "the mitigation failed" };
  } else if (state === "applied") {
    // On the chart's clock, like the recovery after it: a simulated one
    // replays the recording, so its wall time would sit days apart.
    const at = mitigation.recovery?.since ?? mitigation.appliedAt;
    const time = at && hhmm(at);
    apply = { title: "Applied", state: "done", summary: simulated(incident) ? (time ? `simulated · ${time}` : "simulated") : time };
  } else {
    apply = { title: "Applying", state: "current", summary: simulated(incident) ? "simulated, nothing changes" : `on ${incident.service}` };
  }

  // 2. The alert's metric back under its limit, as the recovery watch saw it.
  const recovery = state === "applied" ? mitigation.recovery : undefined;
  let recover: Step;
  if (recovery?.status === "recovered") {
    const last = recovery.series.at(-1)?.value;
    const back = last === undefined ? `back ${sides.healthy} the limit` : `back to ${value(last)}`;
    recover = { title: "Recovered", state: "done", summary: recovery.recoveredAt ? `${back} at ${hhmm(recovery.recoveredAt)}` : back };
  } else if (recovery?.status === "watching") {
    let under = 0;
    while (under < recovery.series.length && healthy(recovery.series.at(-1 - under)!.value, recovery.threshold)) under++;
    recover = { title: "Recovering", state: "current", summary: `${under} min ${sides.healthy} ${value(recovery.threshold)} so far` };
  } else if (recovery) {
    // Without a verification yet, one can be asked for from here: the
    // metric may come back after the watch ends, or have had no requests.
    recover = {
      title: "Not recovered",
      state: "failed",
      summary: notRecoveredWhy(
        recovery.note,
        recovery.checkedAt ? Date.parse(recovery.checkedAt) - Date.parse(recovery.since) : undefined,
      ),
      detail: incident.verification ? undefined : verifyAction("Verify"),
    };
  } else {
    recover = { title: "Recover", state: "todo" };
  }

  // 3. The quiet window that resolves the incident.
  const v = state === "applied" ? incident.verification : undefined;
  let verify: Step;
  // Verified, then reopened: the reopening stands, not the resolution.
  const undone = v && reopenedSinceVerified(incident);
  if (v && undone) {
    verify = {
      title: "Reopened",
      state: "failed",
      summary: `${hhmm(undone.at)} · ${reopenedWords(undone, v)}`,
      detail: verifyAction("Verify again"),
    };
  } else if (v?.status === "resolved") {
    const at = incident.resolvedAt ?? v.finishedAt;
    const window = `${quietMinutes(v)} min ${sides.healthy} ${value(v.threshold)}`;
    verify = { title: "Verified", state: "done", summary: at ? `${window}, resolved ${hhmm(at)}` : window };
  } else if (v?.status === "verifying") {
    verify = { title: "Verifying", state: "current", summary: `${quietMinutes(v)} of ${v.windowMinutes} min ${sides.healthy} ${value(v.threshold)}` };
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
