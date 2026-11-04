"use client";

import { LoaderCircleIcon, RefreshCwIcon, RotateCcwIcon } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useNow } from "@/hooks/use-now";
import { useStartInvestigation } from "@/hooks/use-start-investigation";
import { isArchived } from "@/lib/investigation/archive";
import { rerunBlocker } from "@/lib/investigation/reruns";
import { explainFailure } from "@/lib/investigation/run-failure";
import type { Incident, Run } from "@/lib/investigation/schema";
import { requestRerun } from "./rerun-dialog";

// A failed run on the Overview: what happened, in one line (two at most),
// and a way to try again. Re-run, on this incident, wherever the header's
// re-run dialog can take it (a live run with its snapshot, a scenario);
// else Run again, a new incident, for a replayable scenario. When starting
// one fails, that's the line instead.
export function FailedRunNotice({ incident, run }: { incident: Incident; run: Run & { error: string } }) {
  const scenario = run.source.startsWith("scenario:") ? run.source.slice("scenario:".length) : undefined;
  const retry = useStartInvestigation();
  // As the header decides it: 0 to hydrate, then the clock.
  const now = useNow(0);
  const rerun = !isArchived(incident) && rerunBlocker(incident, now) === undefined;
  const { title, detail } = explainFailure(run.error);
  const line = retry.error ? `Couldn't start a new run: ${retry.error}` : detail;

  return (
    // Room on the right for "Run again", which is wider than the action the
    // Alert reserves space for by default.
    <Alert variant="destructive" className="has-data-[slot=alert-action]:pr-28">
      <AlertTitle>{title}</AlertTitle>
      {line && <AlertDescription className="line-clamp-2 break-words">{line}</AlertDescription>}
      {rerun ? (
        <AlertAction>
          <Button size="xs" variant="outline" onClick={requestRerun}>
            <RefreshCwIcon />
            Re-run
          </Button>
        </AlertAction>
      ) : (
        scenario && (
          <AlertAction>
            <Button size="xs" variant="outline" disabled={retry.pending} onClick={() => retry.start(scenario)}>
              {retry.pending ? <LoaderCircleIcon className="animate-spin" /> : <RotateCcwIcon />}
              Run again
            </Button>
          </AlertAction>
        )
      )}
    </Alert>
  );
}
