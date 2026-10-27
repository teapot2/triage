"use client";

import { ArrowRightIcon, LoaderCircleIcon } from "lucide-react";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block";
import { Terminal } from "@/components/ai-elements/terminal";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Fix, FixRun, SandboxRun } from "@/lib/investigation/schema";
import { modelLabel } from "@/lib/models/labels";
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

// Stages 3 and 4 before there's a fix to show: what Triage is doing, or why
// it couldn't prove one. A proven fix shows as the fix itself instead.
export function FixProgress({ fixRun }: { fixRun: FixRun }) {
  if (fixRun.status === "failed") {
    return (
      <div className="flex flex-col gap-1.5 rounded-lg border p-4">
        <span className="text-muted-foreground text-xs">No proven fix</span>
        <p className="text-sm leading-relaxed">
          Triage couldn&apos;t write a fix that passed the sandbox checks
          {fixRun.attempt > 0 && ` in ${fixRun.attempt} ${fixRun.attempt === 1 ? "attempt" : "attempts"}`}. The diagnosis
          above still stands.
        </p>
        {fixRun.error && <code className="break-words font-mono text-muted-foreground text-xs">{fixRun.error}</code>}
      </div>
    );
  }
  if (fixRun.status === "proven") return null;
  const text =
    fixRun.status === "testing"
      ? `Testing attempt ${fixRun.attempt} in a sandbox: the regression test must fail on the current code, then pass with the fix.`
      : fixRun.attempt > 0
        ? `Attempt ${fixRun.attempt} didn't pass the sandbox checks. Writing attempt ${fixRun.attempt + 1}.`
        : "Writing a fix and a regression test for it.";
  return (
    <p className="flex items-center gap-2 text-muted-foreground text-sm">
      <LoaderCircleIcon className="size-4 shrink-0 animate-spin" />
      {text}
    </p>
  );
}

// The Fix section: what changes, the proof, then the diff and raw sandbox
// output behind underline tabs.
export function FixView({ fix, validation, fixRun }: { fix: Fix; validation?: SandboxRun[]; fixRun?: FixRun }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <span className="text-muted-foreground text-xs">
          {fix.risk} risk{fix.touchesData && " · touches data"} · {fix.files.length} files
          {fixRun?.model && ` · written by ${modelLabel(fixRun.model, fixRun.provider)}`}
        </span>
        <p className="text-sm leading-relaxed">{fix.summary}</p>
        <FixProof validation={validation} />
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
        <TabsList variant="line">
          <TabsTrigger value="diff">Diff</TabsTrigger>
          {validation && <TabsTrigger value="sandbox">Sandbox output</TabsTrigger>}
        </TabsList>
        <TabsContent value="diff">
          <CodeBlock code={fix.patch} language="diff">
            <CodeBlockHeader>
              <CodeBlockTitle>
                <CodeBlockFilename>{fix.files.join(", ")}</CodeBlockFilename>
              </CodeBlockTitle>
              <CodeBlockActions>
                <CodeBlockCopyButton />
              </CodeBlockActions>
            </CodeBlockHeader>
          </CodeBlock>
        </TabsContent>
        {validation && (
          <TabsContent value="sandbox" className="flex flex-col gap-2">
            {validation.map((run) => (
              <Terminal key={run.label} output={`$ ${run.command}  # ${run.label}\n${run.output}`} />
            ))}
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
