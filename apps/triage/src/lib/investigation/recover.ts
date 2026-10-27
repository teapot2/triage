import { isDemo } from "./demo";
import type { Incident } from "./schema";
import { isExample, listIncidents, saveIncident } from "./store";

// Work runs in this server's process, so a restart (a deploy, a crash, a
// dev server stopped mid-run) leaves incidents saying they're still
// running forever. At startup nothing can be running yet: mark each one as
// cut off, so it shows as failed (with Retry where there is one) instead of
// spinning. The demo incidents pose as running on purpose and are left alone.

const RESTARTED = "Triage restarted";

export async function failInterruptedRuns(): Promise<number> {
  const now = new Date().toISOString();
  let fixed = 0;
  for (const incident of await listIncidents()) {
    if (isExample(incident.id) || isDemo(incident.id)) continue;
    const next = recovered(incident, now);
    if (next) {
      await saveIncident(next);
      fixed += 1;
    }
  }
  return fixed;
}

// The incident with every stage that claims to be running marked as cut
// off, or undefined if none was.
function recovered(incident: Incident, now: string): Incident | undefined {
  let next: Incident | undefined;
  const edit = (patch: Partial<Incident>) => (next = { ...(next ?? incident), ...patch });

  if (incident.status === "investigating") {
    edit({
      status: "failed",
      run: incident.run && {
        ...incident.run,
        finishedAt: now,
        error: `${RESTARTED} before the investigation finished`,
      },
    });
  }
  const fixRun = incident.fixRun;
  if (fixRun && (fixRun.status === "writing" || fixRun.status === "testing")) {
    edit({ fixRun: { ...fixRun, status: "failed", finishedAt: now, error: `${RESTARTED} while the fix was being written and tested` } });
  }
  const approval = incident.approval;
  if (approval?.prState === "opening") {
    edit({ approval: { ...approval, prState: "failed", prError: `${RESTARTED} while the PR was being opened` } });
  }
  return next;
}
