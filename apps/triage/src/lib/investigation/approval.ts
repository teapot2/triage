import { notify } from "../notifications/notify";
import { dataChangeOf } from "./fix/data-change";
import { openPullRequest } from "./fix/pull-request";
import type { Approval, Incident } from "./schema";
import { getIncident, saveIncident, withIncidentLock } from "./store";

export type Decision = Extract<Approval["state"], "approved" | "denied">;

export type DecideResult =
  // rerun: the denied fix was archived and the fix stage starts again with
  // the reviewer's feedback (the route runs it after the response). Also
  // the mitigation decision's result, which never reruns anything.
  | { ok: true; incident: Incident; rerun?: boolean }
  | { ok: false; status: 404 | 409; error: string };

// The status once the fix is decided: resolution doesn't wait for the fix.
const afterDecision = (incident: Incident) => (incident.status === "resolved" ? "resolved" : "diagnosed");

// Only a fix Triage proved in its sandbox gets a PR. The bundled examples'
// patches illustrate the UI and don't apply to any real code.
export const canOpenPr = (incident: Incident) => incident.fixRun?.status === "proven";

// Only a proven fix on the live Shopfront can be written again: the fix
// stage needs real source files and a sandbox to prove the new one in. A
// recorded scenario's files are fixtures, and a bundled example has none.
export const canRerunFix = (incident: Incident) =>
  incident.fixRun?.status === "proven" && incident.run?.source === "live:shopfront";

// The incident after a deny with feedback that leads to a new attempt: the
// denied fix, its proof and the decision move into fixAttempts (oldest
// first), the current fix is cleared, and the fix stage is shown as
// writing from attempt 0 until rerunFix picks it up. A resolved incident
// stays resolved. Pure, for the tests.
export function archiveDeniedFix(incident: Incident, approval: Approval, now = new Date().toISOString()): Incident {
  return {
    ...incident,
    status: afterDecision(incident),
    fix: undefined,
    validation: undefined,
    approval: undefined,
    fixRun: { status: "writing", attempt: 0, startedAt: now },
    fixAttempts: [
      ...(incident.fixAttempts ?? []),
      { fix: incident.fix!, validation: incident.validation, fixRun: incident.fixRun!, approval },
    ],
  };
}

export const DATA_NOT_REVIEWED = "this fix changes stored data; confirm you've reviewed it";

// Why this decision can't be taken without more from the reviewer, if it
// can't: approving a fix that changes stored data needs them to say they
// reviewed the data change, since the sandbox never ran it. A deny needs
// nothing. Pure, for the tests.
export function approvalBlocked(incident: Incident, decision: Decision, dataReviewed: boolean): string | undefined {
  if (decision !== "approved" || !incident.fix || dataReviewed) return undefined;
  return dataChangeOf(incident.fix).detected ? DATA_NOT_REVIEWED : undefined;
}

// Records a human's decision on the proposed fix. Only a pending approval can
// be decided, so a second click or a stale tab can't overwrite the first
// decision. Either way the incident stops awaiting approval and is
// "diagnosed": still open until the verification resolves it. One already
// resolved (the alert stayed quiet before anyone decided) stays resolved.
// Approving a proven fix also marks its PR as opening; openPr does the work.
// A deny saves the reviewer's feedback as the reason; with feedback on a fix
// that can be written again, the attempt is archived and a rerun starts.
// Approving a fix that changes stored data needs dataReviewed (409 without).
export function decideApproval(
  id: string,
  decision: Decision,
  feedback?: string,
  dataReviewed = false,
): Promise<DecideResult> {
  // Under the incident's lock, like every route write: the fix stage or a
  // question may be saving at the same time.
  return withIncidentLock(id, async () => {
    const incident = await getIncident(id);
    if (!incident) return { ok: false, status: 404, error: `unknown incident: ${id}` };
    if (!incident.fix || !incident.approval) {
      return { ok: false, status: 409, error: "this incident has no fix awaiting approval" };
    }
    if (incident.approval.state !== "pending") {
      return { ok: false, status: 409, error: `the fix was already ${incident.approval.state}` };
    }
    const blocked = approvalBlocked(incident, decision, dataReviewed);
    if (blocked) return { ok: false, status: 409, error: blocked };

    const now = new Date().toISOString();
    const opening = decision === "approved" && canOpenPr(incident);
    const reason = decision === "denied" ? feedback?.trim() || undefined : undefined;
    const approval: Approval = {
      ...incident.approval,
      state: decision,
      decidedAt: now,
      ...(reason ? { reason } : {}),
      ...(decision === "approved" && dataReviewed && dataChangeOf(incident.fix).detected ? { dataReviewed: true } : {}),
      ...(opening ? { prState: "opening" as const } : {}),
    };
    const rerun = decision === "denied" && reason !== undefined && canRerunFix(incident);
    const decided: Incident = rerun
      ? archiveDeniedFix(incident, approval, now)
      : { ...incident, status: afterDecision(incident), approval };
    await saveIncident(decided);
    return { ok: true, incident: decided, rerun };
  });
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
  const saved: Incident = { ...latest, approval: { ...latest.approval!, ...result } };
  await saveIncident(saved);
  if (result.prState === "opened") notify("pr_opened", saved);
}
