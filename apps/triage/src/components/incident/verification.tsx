"use client";

import { CheckIcon, LoaderCircleIcon, RotateCcwIcon, ShieldCheckIcon, TriangleAlertIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { FormField } from "@/components/form-fields";
import { Timestamp } from "@/components/timestamp";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Textarea } from "@/components/ui/textarea";
import { isArchived } from "@/lib/investigation/archive";
import { reopenedBy } from "@/lib/investigation/postmortem/timeline";
import type { Incident, Reopening, Verification } from "@/lib/investigation/schema";
import { cn } from "@/lib/utils";
import { formatPercent, formatTime } from "./format";
import { metricLabel } from "./metric-labels";
import { errorMessage } from "@/lib/errors";
import { burnText } from "@/lib/slo/model";

// Checking that the fix worked: after the alert's metric recovers, Triage
// watches it for a quiet window and resolves the incident, or reopens it on
// the first minute back over the limit. A person can resolve, reopen or ask
// for another check by hand. Every change goes through the resolution
// route; the page only shows what the server saved.

// The last reopening, when it undid the latest resolution: newer than
// resolvedAt, or any at all while the incident isn't resolved.
export function reopening(incident: Incident): Reopening | undefined {
  const last = incident.reopenings?.at(-1);
  if (!last) return undefined;
  if (!incident.resolvedAt || Date.parse(last.at) > Date.parse(incident.resolvedAt)) return last;
  return undefined;
}

// Completed minutes under the limit so far, at most the window.
export function quietMinutes(v: Verification): number {
  return Math.min(v.windowMinutes, v.series.filter((p) => p.value < v.threshold).length);
}

const formatValue = (value: number, unit: string) =>
  unit === "ratio" ? formatPercent(value) : unit === "×" ? burnText(value) : `${Math.round(value)} ${unit}`;
const hhmm = (iso: string) => formatTime(iso).slice(0, 5);

// What the menu offers now; each matches what the route would take.
// Healthy incidents had nothing to fix, so nothing to check or resolve; an
// archived one takes nothing until it's restored.
export function resolutionOptions(incident: Incident) {
  const open = !isArchived(incident);
  const finished =
    open && incident.report !== undefined && incident.status !== "investigating" && incident.status !== "healthy";
  const v = incident.verification?.status;
  return {
    resolve: finished && incident.status !== "resolved",
    reopen: open && incident.status === "resolved",
    verify: finished && (v === undefined || v === "breached" || v === "stopped"),
    // "again" only once there's been a verification.
    verifyLabel: v === undefined ? "Verify" : "Verify again",
  };
}

type ResolutionAction = "resolve" | "reopen" | "verify";

// The server's words ("a verification is already running: …") as a sentence.
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Resolves, reopens or verifies again through the route, says how it went,
// and refreshes so the page shows what was saved.
export function useResolution(incident: Incident) {
  const router = useRouter();
  const [pending, setPending] = useState<ResolutionAction>();

  async function act(action: ResolutionAction, note?: string) {
    setPending(action);
    try {
      const reason = note?.trim() || undefined;
      const res = await fetch(`/api/incidents/${incident.id}/resolution`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...(reason ? { note: reason } : {}) }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (action === "resolve") toast.success("Incident resolved");
      else if (action === "reopen") toast("Incident reopened", { description: reason });
      else {
        toast("Verifying the fix", {
          description: `Watching ${metricLabel(incident.trigger.metric)} for a quiet window under the limit.`,
        });
      }
    } catch (err) {
      const verb = action === "resolve" ? "resolve" : action === "reopen" ? "reopen" : "verify";
      toast.error(`Couldn't ${verb} the incident`, {
        description: sentence(errorMessage(err)),
      });
    }
    setPending(undefined);
    router.refresh();
  }

  return { act, pending };
}

// Reopening by hand, with an optional word on why, like the fix's deny.
export function ReopenDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  const id = useId();
  const confirm = () => {
    onConfirm(note);
    setNote("");
  };
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setNote("");
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reopen this incident?</AlertDialogTitle>
          <AlertDialogDescription>
            It goes back to what it was waiting on, with the diagnosis as it stands. Nothing is investigated again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormField label="Why?" htmlFor={id} optional>
          <Textarea
            id={id}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={300}
            rows={3}
            placeholder="Checkout errors are back since the evening deploy."
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                confirm();
              }
            }}
          />
        </FormField>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={confirm}>Reopen</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// The verification's progress or outcome as one line, under the recovery
// on the mitigation card, or in its own card when there's no mitigation.
export function VerificationLine({ incident, verification: v }: { incident: Incident; verification: Verification }) {
  const { act, pending } = useResolution(incident);
  const label = metricLabel(v.metric);
  const quiet = quietMinutes(v);
  const again = !isArchived(incident) && (
    <Button variant="outline" size="xs" disabled={pending !== undefined} onClick={() => void act("verify")}>
      {pending === "verify" ? <LoaderCircleIcon className="animate-spin" /> : <RotateCcwIcon />}
      Verify again
    </Button>
  );

  // A merged dependency fix is verified by the audit: resolved once one no
  // longer finds the advisory. Until then each audit's note says it's
  // still there, and what to do.
  if (v.after === "dependencies" && v.status === "verifying") {
    const advisory = incident.dependency?.advisoryId ?? "the advisory";
    return (
      <div className="flex flex-col gap-1">
        <p className="flex items-center gap-2 text-muted-foreground text-sm">
          <LoaderCircleIcon className="size-4 shrink-0 animate-spin" />
          Waiting for an audit that no longer finds {advisory}
        </p>
        {v.note && <p className="pl-6 text-muted-foreground text-xs">{v.note}</p>}
      </div>
    );
  }
  if (v.status === "verifying") {
    return (
      <p className="flex items-center gap-2 text-muted-foreground text-sm">
        <LoaderCircleIcon className="size-4 shrink-0 animate-spin" />
        Verifying: {quiet} of {v.windowMinutes} min under the limit
      </p>
    );
  }
  if (v.status === "resolved") {
    const at = incident.resolvedAt ?? v.finishedAt;
    return (
      <p className="flex items-start gap-1.5 text-success text-sm">
        <CheckIcon className="mt-0.5 size-4 shrink-0" />
        <span>
          Resolved
          {at && (
            <>
              {" "}
              <Timestamp date={at}>{hhmm(at)}</Timestamp>
            </>
          )}
          <span className="text-muted-foreground">
            {" "}
            ·{" "}
            {v.after === "uptime"
              ? `${v.series.length} checks in a row answered in time`
              : v.after === "dependencies"
                ? (v.note ?? "the audit no longer finds the advisory")
                : `${quiet} min under the limit`}
          </span>
        </span>
      </p>
    );
  }
  if (v.status === "breached") {
    const value = v.breachValue === undefined ? undefined : formatValue(v.breachValue, incident.trigger.unit);
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="flex items-start gap-1.5 text-sm text-warning">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <span>
            Back over the limit{v.breachedAt && ` at ${hhmm(v.breachedAt)}`}
            {value && ` (${label} ${value})`}: reopened
          </span>
        </p>
        {again}
      </div>
    );
  }
  // The loop's note may already open with "The verification stopped".
  const note = v.note?.replace(/^the verification stopped:?\s*/i, "");
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <p className="text-muted-foreground text-sm">Verification stopped{note ? `: ${note}` : ""}</p>
      {again}
    </div>
  );
}

const verifiedAfter: Record<Verification["after"], string> = {
  mitigation: "after the mitigation",
  fix: "after the merged fix",
  manual: "asked for by a person",
  uptime: "by the endpoint's own checks",
  dependencies: "by the dependency audit",
};

// The verification on its own, where the mitigation card would be: after a
// merged PR, or one asked for by hand, with no mitigation applied.
export function VerificationCard({
  incident,
  verification,
  className,
}: {
  incident: Incident;
  verification: Verification;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2 rounded-lg border p-4", className)}>
      <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <ShieldCheckIcon className="size-3.5" />
        Verification · {verifiedAfter[verification.after]}
        {verification.after === "uptime"
          ? ` · ${verification.series.length} healthy checks`
          : verification.after === "dependencies"
            ? ""
            : ` · ${verification.windowMinutes} min quiet window`}
      </span>
      <VerificationLine incident={incident} verification={verification} />
    </div>
  );
}

// Above the verdict while the incident is reopened: who reopened it, when
// and why, and what still waits on someone.
export function ReopenedNotice({ incident, reopening: r }: { incident: Incident; reopening: Reopening }) {
  const value = r.value === undefined ? undefined : formatValue(r.value, incident.trigger.unit);
  const waiting = incident.approval?.state === "pending" ? " The fix still waits for approval." : "";
  return (
    <Alert variant="warning" icon={<RotateCcwIcon />}>
      <AlertTitle>
        Reopened by {reopenedBy[r.by]} <Timestamp date={r.at} />
      </AlertTitle>
      <AlertDescription>
        {r.why.trim().replace(/[.!]$/, "")}
        {value && ` (${value})`}.{waiting}
      </AlertDescription>
    </Alert>
  );
}
