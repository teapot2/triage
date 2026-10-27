"use client";

import { LoaderCircleIcon, RotateCcwIcon } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useStartInvestigation } from "@/hooks/use-start-investigation";
import type { Run } from "@/lib/investigation/schema";

// What a failure means, in plain words; the raw error stays visible below
// it for whoever needs to debug it.
function explain(error: string): string {
  if (/^Triage restarted/.test(error)) {
    return "The server restarted while the agent was investigating, so the run stopped partway.";
  }
  if (/no accepted report/i.test(error)) {
    return "The agent ran out of steps before its report passed validation.";
  }
  if (/tool_choice|fetch|network|ECONN|timed? ?out|HTTP \d|api key|unauthor/i.test(error)) {
    return "Triage couldn't reach the model, or the model rejected the request.";
  }
  return "Something went wrong while the agent was investigating.";
}

// A failed run on the Overview: what happened, the raw error, and a way to
// try again when the run came from a replayable scenario.
export function FailedRunNotice({ run }: { run: Run & { error: string } }) {
  const scenario = run.source.startsWith("scenario:") ? run.source.slice("scenario:".length) : undefined;
  const retry = useStartInvestigation();

  return (
    // Room on the right for "Run again", which is wider than the action the
    // Alert reserves space for by default.
    <Alert variant="destructive" className="has-data-[slot=alert-action]:pr-28">
      <AlertTitle>The investigation didn&apos;t finish</AlertTitle>
      <AlertDescription className="flex flex-col gap-1.5">
        <span>{explain(run.error)}</span>
        <code className="break-words font-mono text-muted-foreground text-xs">{run.error}</code>
        {retry.error && <span className="text-destructive text-xs">Couldn&apos;t start a new run: {retry.error}</span>}
      </AlertDescription>
      {scenario && (
        <AlertAction>
          <Button size="xs" variant="outline" disabled={retry.pending} onClick={() => retry.start(scenario)}>
            {retry.pending ? <LoaderCircleIcon className="animate-spin" /> : <RotateCcwIcon />}
            Run again
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}
