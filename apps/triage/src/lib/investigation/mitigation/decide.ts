import type { DecideResult } from "../approval";
import { watchRecovery } from "../recovery";
import type { Incident, Mitigation, Recovery } from "../schema";
import { getIncident, patchIncident } from "../store";
import { Refused as VerificationRefused, startVerification, verificationRefusal } from "../verify";
import { shopfrontOps, simulated } from "./executors";

export type MitigationDecision = Extract<Mitigation["state"], "approved" | "denied">;

class Refused extends Error {}

const setMitigation = (id: string, change: Partial<Mitigation>) =>
  patchIncident(id, (i) => ({ ...i, mitigation: { ...i.mitigation!, ...change } }));

// Records a person's decision on the proposed mitigation. Only a proposed one
// can be decided, so a second click or a stale tab can't overwrite the
// first; approving a failed one is the retry.
export async function decideMitigation(id: string, decision: MitigationDecision): Promise<DecideResult> {
  if (!(await getIncident(id))) return { ok: false, status: 404, error: `unknown incident: ${id}` };
  try {
    const incident = await patchIncident(id, (i): Incident => {
      const m = i.mitigation;
      if (!m) throw new Refused("this incident has no mitigation to decide");
      const open = decision === "approved" ? ["proposed", "failed"] : ["proposed"];
      if (!open.includes(m.state)) throw new Refused(`the mitigation is already ${m.state}`);
      return { ...i, mitigation: { ...m, state: decision, decidedAt: new Date().toISOString(), error: undefined } };
    });
    return { ok: true, incident };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, status: 409, error: err.message };
    throw err;
  }
}

// Runs an approved mitigation and saves what happened, then watches a live
// run's alert until it recovers, then checks that it stays recovered (the
// verification's quiet window). A simulated run's recovery is recorded, so
// its verification starts right away. Never throws.
export async function applyMitigation(id: string): Promise<void> {
  let watch = false;
  let recovered: Recovery | undefined;
  try {
    if ((await getIncident(id))?.mitigation?.state !== "approved") return;
    const running = await setMitigation(id, { state: "running" });
    const executor = running.run?.source === "live:shopfront" ? shopfrontOps : simulated;
    const { output, recovery } = await executor.apply(running);
    await setMitigation(id, { state: "applied", appliedAt: new Date().toISOString(), output, recovery });
    watch = !recovery;
    recovered = recovery;
  } catch (err) {
    console.error("[triage] mitigation failed", id, err);
    const error = (err instanceof Error ? err.message : String(err)).split("\n")[0];
    await setMitigation(id, { state: "failed", error }).catch((e) => console.error("[triage] saving the failure failed", id, e));
    return;
  }
  if (watch) recovered = await watchRecovery(id);
  if (recovered?.status === "recovered" && recovered.recoveredAt) await verifyRecovery(id, recovered.recoveredAt);
}

// Starts the verification after a recovery, when one can start. Never throws.
async function verifyRecovery(id: string, since: string): Promise<void> {
  try {
    const incident = await getIncident(id);
    if (!incident || verificationRefusal(incident, "mitigation")) return;
    const { finished } = await startVerification(id, { after: "mitigation", since });
    await finished;
  } catch (err) {
    if (!(err instanceof VerificationRefused)) console.error("[triage] starting the verification failed", id, err);
  }
}
