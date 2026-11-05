import { lowerIsWorse, pastLimit } from "@/components/incident/metric-labels";
import type { Incident, MetricPoint, Recovery } from "./schema";
import { sourceFor } from "./source-for";
import { sourceKind } from "./source-kind";
import { getIncident, patchIncident } from "./store";
import { metricLookbackMs } from "./watch-rule-model";
import { errorMessage } from "../errors";

const MINUTE = 60_000;
const INTERVAL_MS = 15_000;
const TIMEOUT_MS = 5 * MINUTE;

// When the recovery watch gives up: 5 minutes after it starts, plus how far
// back the metric's points look. A burn rate's point covers the 5 minutes to
// its minute's end, so the outage before the mitigation stays in it that
// long however fast the fix worked; without the extra wait, a burn-rate
// alert could never show two clean minutes in time.
export const recoveryDeadline = (metric: string, startedAt: number) => startedAt + TIMEOUT_MS + metricLookbackMs(metric);

// Whether a value of the metric is past its alert threshold: at or over it,
// over it for a "more than N" count or share of slow requests, or under it
// for a metric where less is worse (an uptime check's availability,
// alerting under 100 %). metric-labels' pastLimit, for the cards too.
export const pastThreshold = pastLimit;

// The points as one per minute (each at its minute's start), keeping the
// minute's worst value: a check's response time comes one point per check,
// and one slow check makes a slow minute. Already per-minute series (the
// live Shopfront's) come back as they were.
export function perMinute(points: MetricPoint[], metric: string): MetricPoint[] {
  const worse = lowerIsWorse(metric) ? Math.min : Math.max;
  const byMinute = new Map<number, number>();
  for (const p of points) {
    const start = Math.floor(Date.parse(p.t) / MINUTE) * MINUTE;
    const seen = byMinute.get(start);
    byMinute.set(start, seen === undefined ? p.value : worse(seen, p.value));
  }
  return [...byMinute]
    .sort(([a], [b]) => a - b)
    .map(([start, value]) => ({ t: new Date(start).toISOString(), value }));
}

export type MetricReader = (metric: string, windowMinutes: number) => Promise<MetricPoint[]>;

// Reads the incident's alert metric as it is now, per minute, from what the
// run can actually see: the live Shopfront's telemetry, or an uptime
// check's saved results (a check of Shopfront included: its trigger is the
// check's own uptime.response_time or uptime.availability, which only the
// check's results hold). Undefined for a recorded scenario, a bundled
// example, the demo or anything else with nothing live to read: those are
// replayed, never watched.
export function liveReader(incident: Incident): MetricReader | undefined {
  const kind = sourceKind(incident);
  if (kind !== "live" && kind !== "uptime") return undefined;
  return async (metric, windowMinutes) => {
    // Anchored now, not at the alert as a question about the incident is.
    const source = await sourceFor({ ...incident, detectedAt: new Date().toISOString() });
    const points = (await source?.queryMetric({ name: metric, windowMinutes }))?.points ?? [];
    return perMinute(points, metric);
  };
}

// Watches a live run's alert metric after its mitigation is applied: every
// 15 s until recoveryDeadline (5 minutes, 10 for a burn rate), until the
// last two completed minutes are back on the healthy side of the threshold.
// Stops early if the mitigation is no longer applied. Never throws; returns
// the last recovery it saved, if any.
export async function watchRecovery(incidentId: string): Promise<Recovery | undefined> {
  let recovery: Recovery | undefined;
  // Saves only while the mitigation is still applied; the returned incident says whether to go on.
  const save = (r: Recovery) =>
    patchIncident(incidentId, (i): Incident =>
      i.mitigation?.state === "applied" ? { ...i, mitigation: { ...i.mitigation, recovery: r } } : i,
    );
  try {
    const incident = await getIncident(incidentId);
    const m = incident?.mitigation;
    if (!incident || m?.state !== "applied" || !m.appliedAt) return undefined;
    const read = liveReader(incident);
    if (!read) throw new Error("nothing live to read for this incident");
    const { metric, threshold } = incident.trigger;
    const past = pastThreshold(metric, threshold);
    const since = Date.parse(m.appliedAt);
    const deadline = recoveryDeadline(metric, Date.now());
    recovery = { metric, threshold, since: m.appliedAt, series: [], status: "watching" };
    let current = await save(recovery);
    const nothing = sourceKind(incident) === "uptime" ? "No checks of the endpoint to judge since the mitigation" : "No requests to judge since the mitigation";

    while (current.mitigation?.state === "applied") {
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
      const now = Date.now();
      const thisMinute = Math.floor(now / MINUTE) * MINUTE;
      const points = await read(metric, 10);
      // A point is its minute's start: one after `since` is wholly after the
      // mitigation. The current minute is still filling.
      const series = points.filter((p) => Date.parse(p.t) > since && Date.parse(p.t) < thisMinute);
      const lastTwo = series.slice(-2);
      const recovered = lastTwo.length === 2 && lastTwo.every((p) => !past(p.value));
      recovery = { ...recovery, series, checkedAt: new Date(now).toISOString() };
      if (recovered) recovery = { ...recovery, status: "recovered", recoveredAt: lastTwo[0].t };
      else if (now >= deadline) {
        recovery = { ...recovery, status: "not_recovered", note: series.length ? undefined : nothing };
      }
      current = await save(recovery);
      if (recovery.status !== "watching") return current.mitigation?.state === "applied" ? recovery : undefined;
    }
    return undefined;
  } catch (err) {
    console.error("[triage] recovery watch failed", incidentId, err);
    if (!recovery) return undefined;
    const note = `The watch stopped: ${errorMessage(err).split("\n")[0]}`;
    recovery = { ...recovery, status: "not_recovered", note };
    await save(recovery).catch(() => {});
    return recovery;
  }
}
