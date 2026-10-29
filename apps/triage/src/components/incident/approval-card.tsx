"use client";

import { CheckIcon, ExternalLinkIcon, GitPullRequestIcon, LoaderCircleIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChangedSinceMount } from "@/hooks/use-changed-since-mount";
import type { Decision } from "@/lib/investigation/approval";
import type { Approval, Fix } from "@/lib/investigation/schema";
import { cn } from "@/lib/utils";

// The decision on the proposed fix, saved on the server. A click shows
// right away; the server then saves it and the page refreshes, so the status
// badge and the sidebar's Needs attention group follow. If saving fails (for
// example another tab decided first), the click is undone, the error shows,
// and the refresh brings in whatever was actually saved.
export function useApprovalDecision(incidentId: string, saved: Approval["state"] | undefined, opensPr: boolean) {
  const router = useRouter();
  const [optimistic, setOptimistic] = useState<Decision>();
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: Decision) {
    setOptimistic(decision);
    setError(null);
    try {
      const res = await fetch(`/api/incidents/${incidentId}/approval`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      // Confirms the save; a failure shows inline, beside the buttons.
      if (decision === "approved") {
        toast.success("Fix approved", {
          description: opensPr ? "Opening a draft pull request with the patch and its test." : "A bundled example, so no PR is opened.",
        });
      }
      else toast("Fix denied", { description: "The diagnosis stands; no change will be made." });
    } catch (err) {
      setOptimistic(undefined);
      setError(err instanceof Error ? err.message : String(err));
    }
    router.refresh();
  }

  return { decision: optimistic ?? saved, decide, error };
}

// The write gate, as header actions. The header owns the decision, since the
// actions show in both the header and its sticky bar. Approve asks first
// (onApprove opens the header's confirm dialog); Deny changes nothing, so it
// doesn't.
export function ApprovalActions({
  incidentId,
  fix,
  approval,
  decision,
  onApprove,
  onDeny,
  error,
}: {
  incidentId: string;
  fix: Fix;
  approval?: Approval;
  decision: Approval["state"];
  onApprove: () => void;
  onDeny: () => void;
  error?: string | null;
}) {
  // A decision made here lands with a pop (and the check draws in); one
  // already made when the page opened just shows.
  const decided = useChangedSinceMount(decision);
  const land = decided && "animate-in fade-in-0 zoom-in-95 duration-200 ease-out motion-reduce:animate-none";

  if (decision === "approved") {
    return (
      <div className="flex items-center gap-2">
        <Badge variant="success" className={cn("gap-1", land)}>
          <CheckIcon className={cn(decided && "*:animate-check-draw motion-reduce:*:animate-none")} />
          Approved
        </Badge>
        {approval && <PullRequestStatus incidentId={incidentId} approval={approval} />}
      </div>
    );
  }
  if (decision === "denied") {
    return (
      <Badge variant="secondary" className={cn("gap-1", land)}>
        <XIcon />
        Denied
      </Badge>
    );
  }
  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-destructive text-xs">{error}</span>}
      <Button variant="ghost" size="sm" onClick={onDeny}>
        Deny
      </Button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="sm" onClick={onApprove}>
            Approve fix
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Opens a draft PR changing {fix.files.length} file(s). Nothing touches production until it&apos;s marked ready
          and merged.
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

// Stage 5 after an approval: the PR opening, a link to it, or why it failed
// with a way to try again. Nothing for an approval that opens no PR.
function PullRequestStatus({ incidentId, approval }: { incidentId: string; approval: Approval }) {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  async function retry() {
    setRetrying(true);
    setRetryError(null);
    try {
      const res = await fetch(`/api/incidents/${incidentId}/pull-request`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : String(err));
    }
    setRetrying(false);
    router.refresh();
  }

  if (approval.prState === "opening") {
    return (
      <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <LoaderCircleIcon className="size-3.5 animate-spin" />
        Opening PR
      </span>
    );
  }
  if (approval.prState === "opened" && approval.prUrl) {
    const number = approval.prUrl.match(/\/pull\/(\d+)/)?.[1];
    return (
      <Button variant="outline" size="sm" asChild>
        <a href={approval.prUrl} target="_blank" rel="noreferrer">
          <GitPullRequestIcon />
          {number ? `Draft PR #${number}` : "View draft PR"}
          <ExternalLinkIcon className="opacity-60" />
        </a>
      </Button>
    );
  }
  if (approval.prState === "failed") {
    return (
      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-default text-destructive text-xs">{retryError ?? "PR not opened"}</span>
          </TooltipTrigger>
          <TooltipContent className="max-w-80">{approval.prError}</TooltipContent>
        </Tooltip>
        <Button variant="outline" size="sm" disabled={retrying} onClick={() => void retry()}>
          {retrying ? <LoaderCircleIcon className="animate-spin" /> : <RotateCcwIcon />}
          Retry
        </Button>
      </div>
    );
  }
  return null;
}

// The write gate's confirmation: approving is the one action that changes
// something outside Triage, so it says what will happen and asks once.
export function ApproveDialog({
  fix,
  opensPr,
  mitigated,
  open,
  onOpenChange,
  onConfirm,
}: {
  fix: Fix;
  opensPr: boolean;
  mitigated: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const files = fix.files.length;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Approve this fix?</AlertDialogTitle>
          <AlertDialogDescription>
            {opensPr ? (
              <>
                Triage opens a draft pull request changing {files} {files === 1 ? "file" : "files"} (
                <span className="font-mono">{fix.files.join(", ")}</span>), with the sandbox proof in its description.
                Nothing touches production until someone marks it ready and merges it.
              </>
            ) : (
              <>This is a bundled example, so approving only records the decision. No PR is opened.</>
            )}
            {mitigated && " Service was restored by the mitigation; this PR is the permanent fix."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Approve fix</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
