import { InvestigationRecorder } from "../recorder";
import type { FixRun } from "../schema";
import { sourceFor } from "../source-for";
import { getIncident, patchIncident, saveIncident } from "../store";
import { runFixStage } from "./agent";
import { errorMessage } from "../../errors";
import { runStageModel } from "../../models/settings";

// Stage 3 again, after a reviewer denied the fix with feedback: the fix
// stage runs on the stored incident with every denied attempt's reason and
// patch, and records its outcome as the first run did (proven goes back to
// awaiting approval; declined or failed stays diagnosed). Never throws: a
// failure lands on fixRun.
export async function rerunFix(id: string, appDir: string): Promise<void> {
  const fail = (error: string) =>
    patchIncident(id, (i) => ({
      ...i,
      fixRun: { ...(i.fixRun ?? { attempt: 0, startedAt: new Date().toISOString() }), status: "failed", finishedAt: new Date().toISOString(), error } satisfies FixRun,
    })).catch((err) => console.error("[triage] failed to record the rerun's failure", id, err));

  try {
    const incident = await getIncident(id);
    // decideApproval left it writing with no fix; anything else means the
    // rerun already ran, or was never asked for.
    if (!incident || incident.fix || incident.fixRun?.status !== "writing") return;
    const source = await sourceFor(incident);
    if (!source) {
      await fail("no telemetry source to write a new fix from");
      return;
    }
    const feedback = (incident.fixAttempts ?? []).map((a) => ({ reason: a.approval.reason ?? "", patch: a.fix.patch }));
    const recorder = new InvestigationRecorder(incident, saveIncident);
    // A promoted re-run's own fix model, else Settings'.
    const stage = await runStageModel("fix", incident.models?.fix);
    await runFixStage(recorder, source, appDir, { feedback, stage });
    await recorder.flush();
  } catch (err) {
    console.error("[triage] fix rerun failed", id, err);
    await fail(errorMessage(err));
  }
}
