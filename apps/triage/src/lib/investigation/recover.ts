import { isDemo } from "./demo";
import type { Incident } from "./schema";
import { isExample, listIncidents, patchIncident } from "./store";

// Work runs in this server's process, so a restart (a deploy, a crash, a
// dev server stopped mid-run) leaves incidents saying they're still
// running forever. At startup nothing can be running yet: mark each one as
// cut off, so it shows as failed (with Retry where there is one) instead of
// spinning. The demo incidents pose as running on purpose and are left alone.
// Archived incidents are checked as well, so none is left claiming to run.

const RESTARTED = "Triage restarted";

export async function failInterruptedRuns(): Promise<number> {
  const now = new Date().toISOString();
  let fixed = 0;
  for (const incident of await listIncidents({ archived: "include" })) {
    if (isDemo(incident.id)) continue;
    const example = isExample(incident.id);
    if (!recovered(incident, now, example)) continue;
    // Worked out again on the incident as it is when saved.
    await patchIncident(incident.id, (i) => recovered(i, now, example) ?? i);
    fixed += 1;
  }
  return fixed;
}

// The incident with every stage that claims to be running marked as cut
// off, or undefined if none was. A bundled example can take questions, a
// mitigation, a verification and a postmortem (and so be cut off in one);
// its other stages pose as they are.
export function recovered(incident: Incident, now: string, example = false): Incident | undefined {
  let next: Incident | undefined;
  const edit = (patch: Partial<Incident>) => (next = { ...(next ?? incident), ...patch });

  const m = incident.mitigation;
  // Approved but not yet applied: its after() never ran, or died during the
  // ops call. Failed, the card offers Retry (approving a failed one again).
  if (m?.state === "approved" || m?.state === "running") {
    edit({ mitigation: { ...m, state: "failed", error: `${RESTARTED} before the mitigation was applied` } });
  } else if (m?.recovery?.status === "watching") {
    edit({
      mitigation: { ...m, recovery: { ...m.recovery, status: "not_recovered", note: `${RESTARTED} before the recovery watch finished` } },
    });
  }
  const verification = incident.verification;
  // A merged dependency fix's verification is no loop in this process: the
  // audits judge it whenever they run (dependencies.ts), so a restart
  // doesn't cut it off.
  if (verification?.status === "verifying" && verification.after !== "dependencies") {
    edit({
      verification: { ...verification, status: "stopped", finishedAt: now, note: `${RESTARTED} before the verification finished` },
    });
  }
  const answers = withAnswersCutOff(next ?? incident, now);
  if (answers) edit({ questions: answers.questions });
  const postmortem = incident.postmortem;
  if (postmortem?.status === "writing") {
    edit({ postmortem: { ...postmortem, status: "failed", finishedAt: now, error: `${RESTARTED} while the postmortem was being written` } });
  }
  if (example) return next;

  const own = cutOffRun(incident, now);
  if (own) edit(own);
  // Re-runs, the same way.
  if (incident.reruns?.some((r) => cutOffRun(r, now))) {
    edit({ reruns: incident.reruns.map((r) => ({ ...r, ...cutOffRun(r, now) })) });
  }
  const approval = incident.approval;
  if (approval?.prState === "opening") {
    edit({ approval: { ...approval, prState: "failed", prError: `${RESTARTED} while the PR was being opened` } });
  }
  return next;
}

// A run's investigation and fix marked as cut off where they claim to be
// running, or undefined if neither does.
function cutOffRun(r: Pick<Incident, "status" | "run" | "fixRun">, now: string): Partial<Incident> | undefined {
  let patch: Partial<Incident> | undefined;
  if (r.status === "investigating") {
    patch = {
      status: "failed",
      run: r.run && { ...r.run, finishedAt: now, error: `${RESTARTED} before the investigation finished` },
    };
  }
  const fixRun = r.fixRun;
  if (fixRun && (fixRun.status === "writing" || fixRun.status === "testing")) {
    patch = { ...patch, fixRun: { ...fixRun, status: "failed", finishedAt: now, error: `${RESTARTED} while the fix was being written and tested` } };
  }
  return patch;
}

// The incident with every question still answering marked as failed, or
// undefined if none was.
function withAnswersCutOff(incident: Incident, now: string): Incident | undefined {
  if (!incident.questions?.some((q) => q.status === "answering")) return undefined;
  return {
    ...incident,
    questions: incident.questions.map((q) =>
      q.status === "answering"
        ? { ...q, status: "failed", answeredAt: now, error: `${RESTARTED} before the answer finished` }
        : q,
    ),
  };
}
