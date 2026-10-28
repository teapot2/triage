"use client";

import { LoaderCircleIcon, RotateCcwIcon } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useStartInvestigation } from "@/hooks/use-start-investigation";
import type { Run } from "@/lib/investigation/schema";

// What a failure means, as one plain title. The raw error shows under it
// only when it says something the title can't: an unrecognized failure, or
// the model's own message about why it refused.
function explain(error: string): { title: string; detail?: string } {
  if (/^Triage restarted/.test(error)) return { title: "The run stopped when Triage restarted" };
  if (/no accepted report/i.test(error)) return { title: "The agent ran out of steps before finishing its report" };
  if (/tool_choice|fetch|network|ECONN|timed? ?out|HTTP \d|api key|unauthor/i.test(error)) {
    return { title: "Couldn't reach the model", detail: error };
  }
  return { title: "The investigation failed", detail: error };
}

// A failed run on the Overview: what happened, in one line (two at most),
// and a way to try again when the run came from a replayable scenario.
// When retrying fails, that's the line instead.
export function FailedRunNotice({ run }: { run: Run & { error: string } }) {
  const scenario = run.source.startsWith("scenario:") ? run.source.slice("scenario:".length) : undefined;
  const retry = useStartInvestigation();
  const { title, detail } = explain(run.error);
  const line = retry.error ? `Couldn't start a new run: ${retry.error}` : detail;

  return (
    // Room on the right for "Run again", which is wider than the action the
    // Alert reserves space for by default.
    <Alert variant="destructive" className="has-data-[slot=alert-action]:pr-28">
      <AlertTitle>{title}</AlertTitle>
      {line && <AlertDescription className="line-clamp-2 break-words">{line}</AlertDescription>}
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
