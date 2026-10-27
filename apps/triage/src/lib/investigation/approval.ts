import { openPullRequest } from "./fix/pull-request";
import type { Approval, Incident } from "./schema";
import { getIncident, saveIncident } from "./store";

export type Decision = Extract<Approval["state"], "approved" | "denied">;

export type DecideResult =
  | { ok: true; incident: Incident }
  | { ok: false; status: 404 | 409; error: string };

// Only a fix Triage proved in its sandbox gets a PR. The bundled examples'
// patches illustrate the UI and don't apply to any real code.
export const canOpenPr = (incident: Incident) => incident.fixRun?.status === "proven";

// Records a human's decision on the proposed fix. Only a pending approval can
// be decided, so a second click or a stale tab can't overwrite the first
// decision. Either way the incident stops awaiting approval and is
// "diagnosed": still open, since nothing is resolved until a fix ships.
// Approving a proven fix also marks its PR as opening; openPr does the work.
export async function decideApproval(id: string, decision: Decision): Promise<DecideResult> {
  const incident = await getIncident(id);
  if (!incident) return { ok: false, status: 404, error: `unknown incident: ${id}` };
  if (!incident.fix || !incident.approval) {
    return { ok: false, status: 409, error: "this incident has no fix awaiting approval" };
  }
  if (incident.approval.state !== "pending") {
    return { ok: false, status: 409, error: `the fix was already ${incident.approval.state}` };
  }

  const opening = decision === "approved" && canOpenPr(incident);
  const decided: Incident = {
    ...incident,
    status: "diagnosed",
    approval: {
      ...incident.approval,
      state: decision,
      decidedAt: new Date().toISOString(),
      ...(opening ? { prState: "opening" as const } : {}),
    },
  };
  await saveIncident(decided);
  return { ok: true, incident: decided };
}

// Retrying a PR that failed to open (no repository yet, a push error).
export async function retryPr(id: string): Promise<DecideResult> {
  const incident = await getIncident(id);
  if (!incident) return { ok: false, status: 404, error: `unknown incident: ${id}` };
  if (incident.approval?.state !== "approved" || !canOpenPr(incident)) {
    return { ok: false, status: 409, error: "only an approved, proven fix gets a PR" };
  }
  if (incident.approval.prState !== "failed") {
    return { ok: false, status: 409, error: `the PR is already ${incident.approval.prState ?? "not requested"}` };
  }
  const retrying: Incident = { ...incident, approval: { ...incident.approval, prState: "opening", prError: undefined } };
  await saveIncident(retrying);
  return { ok: true, incident: retrying };
}

// Stage 5: opens the PR for an incident marked opening, and saves its URL or
// why it failed. Never throws.
export async function openPr(id: string, appDir: string): Promise<void> {
  const incident = await getIncident(id);
  if (!incident?.approval || incident.approval.prState !== "opening") return;
  let result: Partial<Approval>;
  try {
    const prUrl = await openPullRequest(incident, { appDir });
    result = { prState: "opened", prUrl, prError: undefined };
  } catch (err) {
    console.error("[triage] opening the PR failed", id, err);
    result = { prState: "failed", prError: err instanceof Error ? err.message : String(err) };
  }
  // Re-read so nothing saved meanwhile is lost.
  const latest = (await getIncident(id)) ?? incident;
  await saveIncident({ ...latest, approval: { ...latest.approval!, ...result } });
}
