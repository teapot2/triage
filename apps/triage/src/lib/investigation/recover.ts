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
    if (isDemo(incident.id)) continue;
    const next = recovered(incident, now, isExample(incident.id));
    if (next) {
      await saveIncident(next);
      fixed += 1;
    }
  }
  return fixed;
}

// The incident with every stage that claims to be running marked as cut
// off, or undefined if none was. A bundled example can take questions, a
// mitigation and a verification (and so be cut off in one); its other
// stages pose as they are.
export function recovered(incident: Incident, now: string, example = false): Incident | undefined {
  let next: Incident | undefined;
  const edit = (patch: Partial<Incident>) => (next = { ...(next ?? incident), ...patch });

  const m = incident.mitigation;
  if (m?.recovery?.status === "watching") {
    edit({
      mitigation: { ...m, recovery: { ...m.recovery, status: "not_recovered", note: `${RESTARTED} before the recovery watch finished` } },
    });
  }
  const verification = incident.verification;
  if (verification?.status === "verifying") {
    edit({
      verification: { ...verification, status: "stopped", finishedAt: now, note: `${RESTARTED} before the verification finished` },
    });
  }
  const answers = withAnswersCutOff(next ?? incident, now);
  if (answers) edit({ questions: answers.questions });
  if (example) return next;

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
