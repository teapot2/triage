"use client";

import { ArrowRightIcon, ChevronRightIcon, DownloadIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import { Terminal } from "@/components/ai-elements/terminal";
import { useRegisterCommands } from "@/components/command-registry";
import { DiffViewer } from "@/components/diff-viewer";
import { exportHref } from "@/components/export-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fixPatch } from "@/lib/export/datasets/incident";
import { downloadUrl } from "@/lib/export/download";
import { dataChangeOf } from "@/lib/investigation/fix/data-change";
import type { Fix, FixAttempt, FixRun, SandboxRun } from "@/lib/investigation/schema";
import { modelLabel, providerLabels } from "@/lib/models/labels";
import { cn } from "@/lib/utils";
import { useIncident } from "./incident-export";
import { HttpStatusBadge, TestResultBadge } from "./outcome-badges";

// One line of proof the fix works, before -> after in the sandbox: the
// regression test, then the typecheck or a replayed request when the run had
// one. Test runs are the ones with test cases; a typecheck has none.
export function FixProof({ validation }: { validation?: SandboxRun[] }) {
  const before = validation?.find((r) => r.ref === "original" && r.tests.length > 0);
  const after = validation?.find((r) => r.ref === "patched" && r.tests.length > 0);
  const typecheck = validation?.find((r) => r.ref === "patched" && r.tests.length === 0);
  if (!before || !after) return null;

  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-muted-foreground text-xs">
      Regression test
      <TestResultBadge exitCode={before.exitCode} />
      <ArrowRightIcon className="size-3" />
      <TestResultBadge exitCode={after.exitCode} />
      {typecheck && (
        <>
          <span>·</span>
          Typecheck
          <TestResultBadge exitCode={typecheck.exitCode} />
        </>
      )}
      {before.repro && after.repro && (
        <>
          <span>·</span>
          <span className="font-mono">{after.repro.request}</span>
          <HttpStatusBadge status={before.repro.status} />
          <ArrowRightIcon className="size-3" />
          <HttpStatusBadge status={after.repro.status} latencyMs={after.repro.latencyMs} />
        </>
      )}
    </p>
  );
}

// Which attempt the current fix is, once a reviewer has denied one with
// feedback: the denied ones count before it.
export function AttemptBadge({ attempts, className }: { attempts?: FixAttempt[]; className?: string }) {
  if (!attempts?.length) return null;
  return (
    <Badge variant="outline" className={className}>
      Attempt {attempts.length + 1}
    </Badge>
  );
}

// Stages 3 and 4 before there's a fix to show: what Triage is doing, why it
// couldn't prove one, or why it chose not to change code. A proven fix shows
// as the fix itself instead. After a deny with feedback, the new attempt is
// written with it.
export function FixProgress({ fixRun, attempts }: { fixRun: FixRun; attempts?: FixAttempt[] }) {
  const denied = attempts?.length ?? 0;
  if (fixRun.status === "declined") {
    return (
      <div className="flex flex-col gap-1.5 rounded-lg border p-4">
        <span className="text-muted-foreground text-xs">No code change</span>
        <p className="text-sm leading-relaxed">
          Triage judged this isn&apos;t a defect a code change should fix. The diagnosis above still stands.
        </p>
        {fixRun.declinedBecause && <p className="text-muted-foreground text-sm">{fixRun.declinedBecause}</p>}
      </div>
    );
  }
  if (fixRun.status === "failed") {
    return (
      <div className="flex flex-col gap-1.5 rounded-lg border p-4">
        <span className="text-muted-foreground text-xs">No proven fix</span>
        <p className="text-sm leading-relaxed">
          Triage couldn&apos;t write a fix that passed the sandbox checks
          {fixRun.attempt > 0 && ` in ${fixRun.attempt} ${fixRun.attempt === 1 ? "attempt" : "attempts"}`}
          {denied > 0 && " after your feedback"}. The diagnosis above still stands.
        </p>
        {fixRun.error && <code className="break-words font-mono text-muted-foreground text-xs">{fixRun.error}</code>}
      </div>
    );
  }
  if (fixRun.status === "proven") return null;
  const text = fixRun.wakingSince
    ? `Starting the ${providerLabels[fixRun.provider ?? ""] ?? "model's"} deployment. After it scales to zero, its first start takes a few minutes.`
    : fixRun.status === "testing"
      ? `Testing attempt ${fixRun.attempt} in a sandbox: the regression test must fail on the current code, then pass with the fix.`
      : fixRun.attempt > 0
        ? `Attempt ${fixRun.attempt} didn't pass the sandbox checks. Writing attempt ${fixRun.attempt + 1}.`
        : denied > 0
          ? `Writing a new fix that follows your feedback on attempt ${denied}, and a regression test for it.`
          : "Writing a fix and a regression test for it.";
  return (
    <p className="flex items-center gap-2 text-muted-foreground text-sm">
      <LoaderCircleIcon className="size-4 shrink-0 animate-spin" />
      {text}
    </p>
  );
}

// The fixes a reviewer denied with feedback, oldest first, folded away: each
// one's summary, the feedback it got, and its diff.
export function EarlierAttempts({ attempts, className }: { attempts?: FixAttempt[]; className?: string }) {
  if (!attempts?.length) return null;
  return (
    <Collapsible className={cn("group/attempts flex flex-col gap-3", className)}>
      <CollapsibleTrigger className="flex w-fit items-center gap-1.5 text-muted-foreground text-xs hover:text-foreground">
        <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]/attempts:rotate-90 motion-reduce:transition-none" />
        Earlier attempts
        <span className="font-mono tabular-nums">{attempts.length}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="flex flex-col gap-3">
          {attempts.map((attempt, i) => (
            <li key={i} className="flex flex-col gap-2 rounded-lg border p-4">
              <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
                <span className="font-medium text-foreground">Attempt {i + 1}</span>
                <Badge variant="secondary" className="gap-1">
                  <XIcon />
                  Denied
                </Badge>
                <span>
                  {attempt.fix.risk} risk · {attempt.fix.files.length} files
                  {attempt.fixRun.model && ` · written by ${modelLabel(attempt.fixRun.model, attempt.fixRun.provider)}`}
                </span>
              </div>
              <p className="text-sm leading-relaxed">{attempt.fix.summary}</p>
              {attempt.approval.reason && (
                <p className="text-sm">
                  <span className="text-muted-foreground">Feedback: </span>
                  {attempt.approval.reason}
                </p>
              )}
              <FixProof validation={attempt.validation} />
              <DiffViewer patch={attempt.fix.patch} className="mt-1" />
            </li>
          ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}

// The Fix section: what changes, the proof, then the diff and raw sandbox
// output behind underline tabs, and the denied attempts before it, folded.
export function FixView({
  fix,
  validation,
  fixRun,
  attempts,
}: {
  fix: Fix;
  validation?: SandboxRun[];
  fixRun?: FixRun;
  attempts?: FixAttempt[];
}) {
  const data = dataChangeOf(fix);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-muted-foreground text-xs">
          <AttemptBadge attempts={attempts} />
          <span>
            {fix.risk} risk{data.detected && " · changes stored data"} · {fix.files.length} files
            {fixRun?.model && ` · written by ${modelLabel(fixRun.model, fixRun.provider)}`}
          </span>
        </span>
        <p className="text-sm leading-relaxed">{fix.summary}</p>
        <FixProof validation={validation} />
        {data.unproven.length > 0 && (
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-muted-foreground text-xs">
            <Badge variant="warning">Not proven in the sandbox</Badge>
            <span className="font-mono">{data.unproven.join(", ")}</span>
            <span>· the sandbox never runs migrations</span>
          </p>
        )}
        {fixRun?.rejections && fixRun.rejections.length > 0 && (
          <div className="flex flex-col gap-1 text-muted-foreground text-xs">
            <span>
              Proven on attempt {fixRun.attempt}. The sandbox rejected{" "}
              {fixRun.rejections.length === 1 ? "the attempt" : "the attempts"} before it:
            </span>
            <ul className="flex flex-col gap-0.5">
              {fixRun.rejections.map((why, i) => (
                <li key={i} className="font-mono">
                  {i + 1}. {why}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <Tabs defaultValue="diff" className="gap-3">
        <div className="flex items-center justify-between gap-2">
          <TabsList variant="line">
            <TabsTrigger value="diff">Diff</TabsTrigger>
            {validation && <TabsTrigger value="sandbox">Sandbox output</TabsTrigger>}
          </TabsList>
          <PatchDownload />
        </div>
        <TabsContent value="diff">
          <DiffViewer patch={fix.patch} />
        </TabsContent>
        {validation && (
          <TabsContent value="sandbox" className="flex flex-col gap-2">
            {validation.map((run) => (
              <Terminal key={run.label} output={`$ ${run.command}  # ${run.label}\n${run.output}`} />
            ))}
          </TabsContent>
        )}
      </Tabs>

      <EarlierAttempts attempts={attempts} className="border-t pt-4" />
    </div>
  );
}

// The diff as a file to `git apply`, exactly as stored: one format, so a
// link rather than a menu. Also in the search palette.
function PatchDownload() {
  const incident = useIncident();
  const href = incident && exportHref(fixPatch, { id: incident.id }, "patch");
  useRegisterCommands(
    "fix-patch",
    href ? [{ id: "download-patch", group: "Export", label: "Download the fix as a .patch", icon: DownloadIcon, keywords: "export diff git apply", run: () => downloadUrl(href) }] : [],
  );
  if (!href) return null;
  return (
    <Button variant="ghost" size="xs" asChild>
      <a href={href} download>
        <DownloadIcon />
        .patch
      </a>
    </Button>
  );
}
