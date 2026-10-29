import { createLiveSource } from "./live/live-source";
import type { Incident, Recovery } from "./schema";
import { getIncident, patchIncident } from "./store";

const MINUTE = 60_000;
const INTERVAL_MS = 15_000;
const TIMEOUT_MS = 5 * MINUTE;

// Watches a live run's alert metric after its mitigation is applied: every
// 15 s for up to 5 minutes, until the last two completed minutes are under
// the threshold. Stops early if the mitigation is no longer applied. Never
// throws.
export async function watchRecovery(incidentId: string): Promise<void> {
  let recovery: Recovery | undefined;
  // Saves only while the mitigation is still applied; the returned incident says whether to go on.
  const save = (r: Recovery) =>
    patchIncident(incidentId, (i): Incident =>
      i.mitigation?.state === "applied" ? { ...i, mitigation: { ...i.mitigation, recovery: r } } : i,
    );
  try {
    const incident = await getIncident(incidentId);
    const m = incident?.mitigation;
    if (!incident || m?.state !== "applied" || !m.appliedAt) return;
    const { metric, threshold } = incident.trigger;
    const since = Date.parse(m.appliedAt);
    const deadline = Date.now() + TIMEOUT_MS;
    recovery = { metric, threshold, since: m.appliedAt, series: [], status: "watching" };
    let current = await save(recovery);

    while (current.mitigation?.state === "applied") {
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
      const now = Date.now();
      const thisMinute = Math.floor(now / MINUTE) * MINUTE;
      const points = (await (await createLiveSource()).queryMetric({ name: metric, windowMinutes: 10 }))?.points ?? [];
      // A point is its minute's start: one after `since` is wholly after the
      // mitigation. The current minute is still filling.
      const series = points.filter((p) => Date.parse(p.t) > since && Date.parse(p.t) < thisMinute);
      const lastTwo = series.slice(-2);
      const recovered = lastTwo.length === 2 && lastTwo.every((p) => p.value < threshold);
      recovery = { ...recovery, series, checkedAt: new Date(now).toISOString() };
      if (recovered) recovery = { ...recovery, status: "recovered", recoveredAt: lastTwo[0].t };
      else if (now >= deadline) {
        recovery = {
          ...recovery,
          status: "not_recovered",
          note: series.length ? undefined : "No requests to judge since the mitigation",
        };
      }
      current = await save(recovery);
      if (recovery.status !== "watching") return;
    }
  } catch (err) {
    console.error("[triage] recovery watch failed", incidentId, err);
    if (!recovery) return;
    const note = `The watch stopped: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`;
    await save({ ...recovery, status: "not_recovered", note }).catch(() => {});
  }
}
