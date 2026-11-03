"use client";

import {
  ChevronDownIcon,
  LoaderCircleIcon,
  type LucideIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldIcon,
  ShieldXIcon,
  XIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
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
import type { Incident, Mitigation } from "@/lib/investigation/schema";
import { cn } from "@/lib/utils";
import { Citations } from "./evidence";
import { formatPercent, formatTime } from "./format";
import { THIS_INCIDENT } from "./incident-commands";
import type { ChartMarker } from "./metric-chart";
import { metricLabel } from "./metric-labels";
import { VerificationLine } from "./verification";
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
  const status = mitigationStatus(state, mitigation, incident, { readOnly, error });

  return (
    // Closed, the card is the action, where it stands, and the decision;
    // why, the steps and the undo open under Details. Approving shows the
    // steps again in its dialog, so they're never approved unseen.
    <Collapsible className={cn("rounded-lg border", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 p-4">
        <status.Icon className={cn("mt-0.5 size-4 shrink-0 self-start", status.iconClass)} aria-hidden />
        <div className="min-w-0 flex-1 basis-56">
          <p className="font-medium text-sm">
            <span className="sr-only">Mitigation: </span>
            {mitigation.title}
          </p>
          <p className={cn("text-muted-foreground text-xs", land)}>{status.line}</p>
        </div>
        <div className="ml-auto flex items-center gap-1">
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
        {mitigation.state === "applied" && incident.verification && (
          <div className="basis-full pl-7">
            <VerificationLine incident={incident} verification={incident.verification} />
          </div>
        )}
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

// The card's icon and the line under its title, for where the mitigation
// stands: what approving means while it's proposed, then its progress, and
// once applied, whether the alert's metric came back.
function mitigationStatus(
  state: Mitigation["state"],
  mitigation: Mitigation,
  incident: Incident,
  { readOnly, error }: { readOnly: boolean; error: string | null },
): { Icon: LucideIcon; iconClass?: string; line: React.ReactNode } {
  const applied = mitigation.appliedAt ? `Applied ${formatTime(mitigation.appliedAt)}` : "Applied";
  switch (state) {
    case "proposed": {
      const n = mitigation.steps.length;
      const facts = `${n} ${n === 1 ? "step" : "steps"} · ${mitigation.risk.replace(/_/g, " ")} risk · reversible`;
      if (error) return { Icon: ShieldIcon, iconClass: "text-muted-foreground", line: <span className="text-destructive">{error}</span> };
      return { Icon: ShieldIcon, iconClass: "text-muted-foreground", line: readOnly ? `${facts} · use the run to approve it` : facts };
    }
    case "approved":
    case "running":
      return { Icon: LoaderCircleIcon, iconClass: "animate-spin text-muted-foreground", line: `Applying on ${incident.service}` };
    case "failed":
      return {
        Icon: ShieldAlertIcon,
        iconClass: "text-destructive",
        line: <span className="text-destructive">{error ?? mitigation.error ?? "The mitigation failed"}</span>,
      };
    case "denied":
      return { Icon: ShieldXIcon, iconClass: "text-muted-foreground", line: "Denied · nothing was changed" };
    case "applied":
      break;
  }
  const recovery = mitigation.recovery;
  const label = recovery && metricLabel(recovery.metric);
  if (recovery?.status === "watching") {
    let under = 0;
    while (under < recovery.series.length && recovery.series.at(-1 - under)!.value < recovery.threshold) under++;
    return {
      Icon: LoaderCircleIcon,
      iconClass: "animate-spin text-muted-foreground",
      line: `${applied} · watching ${label} · ${under} min under the limit`,
    };
  }
  if (recovery?.status === "recovered") {
    const unit = incident.trigger.unit;
    const last = recovery.series.at(-1)?.value;
    const value = last === undefined ? undefined : unit === "ratio" ? formatPercent(last) : `${Math.round(last)} ${unit}`;
    return {
      Icon: ShieldCheckIcon,
      iconClass: "text-success",
      line: (
        <>
          {applied} ·{" "}
          <span className="text-success">
            Recovered: {label}
            {value && ` at ${value}`}
          </span>
          {recovery.recoveredAt && ` · ${formatTime(recovery.recoveredAt)}`}
        </>
      ),
    };
  }
  if (recovery) {
    // A note means the watch was cut off (a restart), not that it ran its
    // 5 min; the note itself is under Details.
    return {
      Icon: ShieldAlertIcon,
      iconClass: "text-warning",
      line: (
        <>
          {applied} · <span className="text-warning">{recovery.note ? "Recovery watch stopped" : "Not recovered after 5 min"}</span>
        </>
      ),
    };
  }
  return { Icon: ShieldCheckIcon, iconClass: "text-foreground", line: applied };
}
