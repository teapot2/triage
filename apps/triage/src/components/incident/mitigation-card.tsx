"use client";

import { CheckIcon, LoaderCircleIcon, RotateCcwIcon, ShieldIcon, XIcon } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useChangedSinceMount } from "@/hooks/use-changed-since-mount";
import type { Incident, Mitigation, Recovery } from "@/lib/investigation/schema";
import { cn } from "@/lib/utils";
import { Citations } from "./evidence";
import { formatPercent, formatTime } from "./format";
import { THIS_INCIDENT } from "./incident-commands";
import type { ChartMarker } from "./metric-chart";
import { metricLabel } from "./metric-labels";

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
      setError(err instanceof Error ? err.message : String(err));
    }
    router.refresh();
  }

  const state = optimistic && optimistic.over === saved ? optimistic.decision : saved;
  return { state, decide, error };
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
export function MitigationCard({ incident, className }: { incident: Incident; className?: string }) {
  const mitigation = incident.mitigation!;
  const { state, decide, error } = useMitigationDecision(incident.id, mitigation.state);
  const [confirming, setConfirming] = useState(false);
  useRegisterCommands(
    "incident-mitigation",
    state === "proposed"
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
  const land = decided && "animate-in fade-in-0 zoom-in-95 duration-200 ease-out motion-reduce:animate-none";

  return (
    <div className={cn("flex flex-col gap-2 rounded-lg border p-4", className)}>
      <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <ShieldIcon className="size-3.5" />
        Mitigation · {mitigation.risk.replace(/_/g, " ")} risk · reversible
      </span>
      <p className="font-medium text-sm">{mitigation.title}</p>
      <p className="text-sm leading-relaxed">
        {mitigation.why.text} <Citations ids={mitigation.why.evidenceIds} />
      </p>
      <ol className="list-decimal pl-5 text-sm leading-relaxed">
        {mitigation.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <p className="text-muted-foreground text-xs">To undo: {mitigation.undo}</p>

      <div className="mt-1 flex flex-col gap-1.5">
        {state === "proposed" && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => setConfirming(true)}>
              Approve mitigation
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void decide("denied")}>
              Deny
            </Button>
            {error && <span className="text-destructive text-xs">{error}</span>}
          </div>
        )}
        {(state === "approved" || state === "running") && (
          <p className="flex items-center gap-2 text-muted-foreground text-sm">
            <LoaderCircleIcon className="size-4 shrink-0 animate-spin" />
            Applying on {incident.service}
          </p>
        )}
        {state === "applied" && (
          <>
            <p className="flex items-center gap-1.5 text-sm">
              <CheckIcon className="size-4 shrink-0" />
              Applied{mitigation.appliedAt && ` ${formatTime(mitigation.appliedAt)}`}
            </p>
            {mitigation.output && (
              <code className="break-words font-mono text-muted-foreground text-xs">{mitigation.output}</code>
            )}
          </>
        )}
        {state === "failed" && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-destructive text-xs">{error ?? mitigation.error ?? "The mitigation failed"}</span>
            <Button variant="outline" size="sm" onClick={() => void decide("approved")}>
              <RotateCcwIcon />
              Retry
            </Button>
          </div>
        )}
        {state === "denied" && (
          <Badge variant="secondary" className={cn("gap-1 self-start", land)}>
            <XIcon />
            Denied
          </Badge>
        )}
        {mitigation.recovery && <RecoveryLine recovery={mitigation.recovery} unit={incident.trigger.unit} />}
      </div>

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
    </div>
  );
}

function RecoveryLine({ recovery, unit }: { recovery: Recovery; unit: string }) {
  const label = metricLabel(recovery.metric);
  if (recovery.status === "watching") {
    let under = 0;
    while (under < recovery.series.length && recovery.series.at(-1 - under)!.value < recovery.threshold) under++;
    return (
      <p className="flex items-center gap-2 text-muted-foreground text-sm">
        <LoaderCircleIcon className="size-4 shrink-0 animate-spin" />
        Watching {label} · {under} min under the limit
      </p>
    );
  }
  if (recovery.status === "recovered") {
    const last = recovery.series.at(-1)?.value;
    const value = last === undefined ? undefined : unit === "ratio" ? formatPercent(last) : `${Math.round(last)} ${unit}`;
    return (
      <p className="flex items-start gap-1.5 text-success text-sm">
        <CheckIcon className="mt-0.5 size-4 shrink-0" />
        <span>
          Recovered: {label}
          {value && ` at ${value}`}
          {recovery.recoveredAt && <span className="text-muted-foreground"> · {formatTime(recovery.recoveredAt)}</span>}
        </span>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-0.5 text-sm">
      <p className="text-warning">Not recovered after 5 min</p>
      {recovery.note && <p className="text-muted-foreground text-xs">{recovery.note}</p>}
    </div>
  );
}
