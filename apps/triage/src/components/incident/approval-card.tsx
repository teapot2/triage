"use client";

import { CheckIcon, ExternalLinkIcon, GitMergeIcon, GitPullRequestIcon, LoaderCircleIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
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
import { FormField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChangedSinceMount } from "@/hooks/use-changed-since-mount";
import type { Decision } from "@/lib/investigation/approval";
import { dataChangeOf } from "@/lib/investigation/fix/data-change";
import type { Approval, Fix } from "@/lib/investigation/schema";
import { cn } from "@/lib/utils";
import { DataChangeReview } from "./data-change-review";
import { errorMessage } from "@/lib/errors";

// The decision on the proposed fix, saved on the server. A click shows
// right away; the server then saves it and the page refreshes, so the status
// badge and the sidebar's Needs attention group follow. If saving fails (for
// example another tab decided first), the click is undone, the error shows,
// and the refresh brings in whatever was actually saved. A deny can carry
// feedback; on a fix that can be written again the server then starts a new
// attempt (rerun in its response), and the refresh shows the fix stage
// writing. Approving a fix that changes stored data sends dataReviewed once
// the approver has ticked that they read it; the server refuses it without.
export function useApprovalDecision(incidentId: string, saved: Approval["state"] | undefined, opensPr: boolean) {
  const router = useRouter();
  const [optimistic, setOptimistic] = useState<Decision>();
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: Decision, feedback?: string, dataReviewed = false) {
    const reason = feedback?.trim() || undefined;
    setOptimistic(decision);
    setError(null);
    try {
      const res = await fetch(`/api/incidents/${incidentId}/approval`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, ...(reason ? { feedback: reason } : {}), ...(dataReviewed ? { dataReviewed } : {}) }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; rerun?: boolean };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      // Confirms the save; a failure shows inline, beside the buttons.
      if (decision === "approved") {
        toast.success("Fix approved", {
          description: opensPr ? "Opening a draft pull request with the patch and its test." : "A bundled example, so no PR is opened.",
        });
      } else if (data.rerun) {
        toast("Fix denied, writing a new one", { description: "Triage is writing a fix that follows your feedback." });
      } else {
        toast("Fix denied", {
          description: reason
            ? "The diagnosis stands; your feedback is recorded and no new attempt follows."
            : "The diagnosis stands; no change will be made.",
        });
      }
    } catch (err) {
      setOptimistic(undefined);
      setError(errorMessage(err));
    }
    router.refresh();
  }

  return { decision: optimistic ?? saved, decide, error };
}

// The write gate, as header actions. The header owns the decision, since the
// actions show in both the header and its sticky bar. Both ask first:
// onApprove opens the header's confirm dialog, onDeny its deny dialog, where
// the reviewer can say what the next fix should do differently.
export function ApprovalActions({
  incidentId,
  fix,
  approval,
  decision,
  onApprove,
  onDeny,
  error,
  archived = false,
  quietOnceMerged = false,
}: {
  incidentId: string;
  fix: Fix;
  approval?: Approval;
  decision: Approval["state"];
  onApprove: () => void;
  onDeny: () => void;
  error?: string | null;
  // Read-only: the decision as it stands, and nothing to decide or retry.
  archived?: boolean;
  // Once the PR is merged, the PR alone: a merged PR was approved.
  quietOnceMerged?: boolean;
}) {
  // A decision made here lands with a pop (and the check draws in); one
  // already made when the page opened just shows.
  const decided = useChangedSinceMount(decision);
  const land = decided && "animate-in fade-in-0 zoom-in-95 duration-200 ease-out motion-reduce:animate-none";

  if (decision === "approved") {
    if (quietOnceMerged && approval?.prMergedAt) return <PullRequestStatus incidentId={incidentId} approval={approval} archived={archived} />;
    return (
      <div className="flex items-center gap-2">
        <span className={cn("inline-flex items-center gap-1 font-medium text-success text-xs", land)}>
          <CheckIcon className={cn("size-3.5", decided && "*:animate-check-draw motion-reduce:*:animate-none")} aria-hidden />
          Approved
        </span>
        {approval && <PullRequestStatus incidentId={incidentId} approval={approval} archived={archived} />}
      </div>
    );
  }
  if (decision === "denied") {
    const badge = (
      <span className={cn("inline-flex items-center gap-1 font-medium text-muted-foreground text-xs", land)}>
        <XIcon className="size-3.5" aria-hidden />
        Denied
      </span>
    );
    if (!approval?.reason) return badge;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-default">{badge}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-80">{approval.reason}</TooltipContent>
      </Tooltip>
    );
  }
  if (archived) return null;
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
function PullRequestStatus({ incidentId, approval, archived }: { incidentId: string; approval: Approval; archived: boolean }) {
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
      setRetryError(errorMessage(err));
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
    // Merged, as the PR check last saw it: no longer a draft.
    const merged = approval.prMergedAt !== undefined;
    return (
      <Button variant="outline" size="sm" asChild>
        <a href={approval.prUrl} target="_blank" rel="noreferrer">
          {merged ? <GitMergeIcon /> : <GitPullRequestIcon />}
          {merged ? (number ? `PR #${number} merged` : "View merged PR") : number ? `Draft PR #${number}` : "View draft PR"}
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
        {!archived && (
          <Button variant="outline" size="sm" disabled={retrying} onClick={() => void retry()}>
            {retrying ? <LoaderCircleIcon className="animate-spin" /> : <RotateCcwIcon />}
            Retry
          </Button>
        )}
      </div>
    );
  }
  return null;
}

// The write gate's confirmation: approving is the one action that changes
// something outside Triage, so it says what will happen and asks once. A
// fix that changes stored data also shows that change, and Approve waits
// for the box saying it was reviewed. That change can be taller than the
// window, so it scrolls between a fixed header and footer, and Cancel and
// Approve stay in reach.
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
  onConfirm: (dataReviewed: boolean) => void;
}) {
  const files = fix.files.length;
  const change = dataChangeOf(fix);
  const [reviewed, setReviewed] = useState(false);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setReviewed(false);
        onOpenChange(next);
      }}
    >
      <AlertDialogContent className={cn(change.detected && "flex flex-col data-[size=default]:sm:max-w-lg")}>
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
        {change.detected && (
          <div className="-mx-4 min-h-0 overflow-y-auto overscroll-contain px-4 pb-1 scrollbar-subtle">
            <DataChangeReview fix={fix} change={change} reviewed={reviewed} onReviewedChange={setReviewed} />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={change.detected && !reviewed} onClick={() => onConfirm(change.detected && reviewed)}>
            Approve fix
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Why feedback on a deny starts no new attempt here (see canRerunFix).
export type NoRerunReason = "example" | "scenario" | "unproven";

const noRerunNotes: Record<NoRerunReason, string> = {
  example: "This is a bundled example: the feedback is recorded, no new attempt follows.",
  scenario: "This is a recorded scenario: the feedback is recorded, no new attempt follows.",
  unproven: "This fix was never proven in a sandbox: the feedback is recorded, no new attempt follows.",
};

// Denying, with a say in what comes next. Empty, it records the decision as
// before. With feedback on a fix that can be written again, Triage keeps
// this attempt as history and writes another one that follows the feedback.
export function DenyDialog({
  noRerun,
  open,
  onOpenChange,
  onConfirm,
}: {
  // Why feedback starts no new attempt here, or undefined when it does.
  noRerun?: NoRerunReason;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (feedback: string) => void;
}) {
  const [feedback, setFeedback] = useState("");
  const id = useId();
  const retries = feedback.trim().length > 0 && !noRerun;
  const confirm = () => {
    onConfirm(feedback);
    setFeedback("");
  };
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setFeedback("");
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Deny this fix?</AlertDialogTitle>
          <AlertDialogDescription>
            {noRerun
              ? noRerunNotes[noRerun]
              : "The diagnosis stands. Say what the next fix should do differently and Triage writes and proves a new one that follows it, or leave it empty to deny without another attempt."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormField label="What should Triage do differently?" htmlFor={id} optional>
          <Textarea
            id={id}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            maxLength={500}
            rows={3}
            placeholder="Don't change the query, only release the connection."
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
          <AlertDialogAction onClick={confirm}>{retries ? "Deny and try again" : "Deny"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
