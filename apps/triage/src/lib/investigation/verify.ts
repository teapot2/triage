import { metricLabel } from "@/components/incident/metric-labels";
import { createLiveSource } from "./live/live-source";
import { withUnit } from "./postmortem/timeline";
import type { Incident, MetricPoint, Reopening, Verification } from "./schema";
import { notify } from "../notifications/notify";
import { getIncident, patchIncident } from "./store";
import { errorMessage } from "@/lib/errors";

// Checks that the fix worked: after the alert's metric recovers, a quiet
// window of completed minutes under the threshold resolves the incident,
// and the first minute back over it reopens the incident.

const MINUTE = 60_000;
export const RESOLVE_AFTER_MINUTES = Number(process.env.TRIAGE_RESOLVE_AFTER_MINUTES) || 5;
export const VERIFY_INTERVAL_MS = 15_000;

export class Refused extends Error {}

export type WindowJudgment =
  | { kind: "breached"; at: string; value: number }
  | { kind: "resolved"; at: string }
  | { kind: "verifying"; quiet: number };

// Judges the completed minutes since the recovery: breached on the first
// one at or over the threshold, resolved once windowMinutes of them are all
// under it. A minute with no point (no requests) neither counts nor breaks
// the window.
export function judgeWindow(series: MetricPoint[], threshold: number, windowMinutes: number): WindowJudgment {
  const over = series.find((p) => p.value >= threshold);
  if (over) return { kind: "breached", at: over.t, value: over.value };
  if (series.length >= windowMinutes) return { kind: "resolved", at: series.at(-1)!.t };
  return { kind: "verifying", quiet: series.length };
}

// The incident resolved at `at`. Only this and the verification loop set
// the status to resolved.
export function resolved(incident: Incident, at: string): Incident {
  return { ...incident, status: "resolved", resolvedAt: at };
}

const minuteOf = (t: string) => Math.floor(Date.parse(t) / MINUTE);

// The incident reopened: the reopening is recorded with the resolution it
// undid, and the status goes back to what it was waiting on. A second
// reopening in the same minute as the last (the watch and the verification
// seeing the same breach) changes nothing, unless the incident was resolved
// again in between.
export function reopened(incident: Incident, reopening: Omit<Reopening, "resolvedAt">): Incident {
  const last = incident.reopenings?.at(-1);
  if (last && incident.status !== "resolved" && minuteOf(last.at) === minuteOf(reopening.at)) return incident;
  return {
    ...incident,
    status: incident.approval?.state === "pending" ? "awaiting_approval" : "diagnosed",
    resolvedAt: undefined,
    reopenings: [
      ...(incident.reopenings ?? []),
      { ...reopening, ...(incident.resolvedAt ? { resolvedAt: incident.resolvedAt } : {}) },
    ],
  };
}

// Why a verification can't start now, or undefined when it can: once the
// investigation has a report, one at a time, and on a resolved incident
// only when a person asks for it.
export function verificationRefusal(incident: Incident, after: Verification["after"]): string | undefined {
  if (incident.status === "investigating" || !incident.report) {
    return "the investigation has no report yet: verify once it has finished";
  }
  if (incident.verification?.status === "verifying") return "a verification is already running: wait for it to finish";
  if (incident.status === "resolved" && after !== "manual") return "the incident is already resolved";
  return undefined;
}

// Why a person can't resolve the incident by hand now, or undefined when
// they can.
export function resolveRefusal(incident: Incident): string | undefined {
  if (incident.status === "resolved") return "the incident is already resolved";
  if (incident.status === "investigating" || !incident.report) {
    return "the investigation has no report yet: resolve once it has finished";
  }
  return undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const firstLine = (err: unknown) => errorMessage(err).split("\n")[0];

// Starts a verification: saves the record (or throws Refused with the
// reason), then watches the window. `finished` settles when the loop ends
// and never rejects: a failure lands on the record as stopped, with a note.
export async function startVerification(
  incidentId: string,
  { after, since }: { after: Verification["after"]; since: string },
): Promise<{ finished: Promise<void> }> {
  const startedAt = new Date().toISOString();
  const incident = await patchIncident(incidentId, (i): Incident => {
    const refusal = verificationRefusal(i, after);
    if (refusal) throw new Refused(refusal);
    const { metric, threshold } = i.trigger;
    const windowMinutes = RESOLVE_AFTER_MINUTES;
    return {
      ...i,
      verification: { after, since, windowMinutes, metric, threshold, series: [], status: "verifying", startedAt },
    };
  });
  return { finished: verify(incident) };
}

async function verify(incident: Incident): Promise<void> {
  const v = incident.verification!;
  const { id } = incident;
  // This verification, while it's still the one on the incident and still
  // running; anything else (a newer one, a restart) owns the record now.
  const ours = (i: Incident) => i.verification?.startedAt === v.startedAt && i.verification.status === "verifying";
  // Saves the record, then `apply` on the freshly read incident, so nothing
  // saved meanwhile is lost. Says whether the loop goes on.
  const save = async (change: Partial<Verification>, apply?: (i: Incident) => Incident) => {
    const saved = await patchIncident(id, (i) => {
      if (!ours(i)) return i;
      const next = { ...i, verification: { ...i.verification!, ...change } };
      return apply ? apply(next) : next;
    });
    return ours(saved);
  };
  const why = `${metricLabel(v.metric)} back over ${withUnit(v.threshold, incident.trigger.unit)}`;
  // Saves the series and acts on the judgment; true while still verifying.
  const check = async (series: MetricPoint[], now: number, resolvedAt = (at: string) => at) => {
    const checkedAt = new Date(now).toISOString();
    const judgment = judgeWindow(series, v.threshold, v.windowMinutes);
    if (judgment.kind === "resolved") {
      const at = resolvedAt(judgment.at);
      // A person may have resolved it meanwhile; their time stands.
      await save({ series, checkedAt, status: "resolved", finishedAt: checkedAt }, (i) =>
        i.status === "resolved" ? i : resolved(i, at),
      );
      // Whoever resolved it, once: the key is the resolution's time.
      const saved = await getIncident(id);
      if (saved?.status === "resolved") notify("resolved", saved);
      return false;
    }
    if (judgment.kind === "breached") {
      const { at, value } = judgment;
      await save(
        { series, checkedAt, status: "breached", breachedAt: at, breachValue: value, finishedAt: checkedAt },
        (i) => reopened(i, { at, by: "verification", why, value }),
      );
      return false;
    }
    return save({ series, checkedAt });
  };

  try {
    if (incident.run?.source === "live:shopfront") await watchLive(v, check, save);
    else await replay(incident, v, check);
  } catch (err) {
    console.error("[triage] verification failed", id, err);
    await save({ status: "stopped", finishedAt: new Date().toISOString(), note: `The verification stopped: ${firstLine(err)}` }).catch(
      () => {},
    );
  }
}

type Check = (series: MetricPoint[], now: number, resolvedAt?: (at: string) => string) => Promise<boolean>;

// A live run: the alert's metric from Shopfront every 15 s, as the recovery
// watch reads it, until the window is judged or the timeout.
async function watchLive(
  v: Verification,
  check: Check,
  save: (change: Partial<Verification>) => Promise<boolean>,
): Promise<void> {
  const since = Date.parse(v.since);
  const deadline = Date.parse(v.startedAt) + (v.windowMinutes + 10) * MINUTE;
  // Kept across checks: a window longer than the query's drops nothing.
  const byMinute = new Map<string, MetricPoint>();
  for (;;) {
    await sleep(VERIFY_INTERVAL_MS);
    const now = Date.now();
    const thisMinute = Math.floor(now / MINUTE) * MINUTE;
    const points = (await (await createLiveSource()).queryMetric({ name: v.metric, windowMinutes: 10 }))?.points ?? [];
    // A point is its minute's start: one after `since` is wholly after the
    // recovery. The current minute is still filling.
    for (const p of points) if (Date.parse(p.t) > since && Date.parse(p.t) < thisMinute) byMinute.set(p.t, p);
    const series = [...byMinute.values()].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    if (!(await check(series, now))) return;
    if (now >= deadline) {
      const minutes = Math.round((now - Date.parse(v.startedAt)) / MINUTE);
      const note = series.length ? `Still verifying after ${minutes} min` : "No completed minutes to judge";
      await save({ status: "stopped", finishedAt: new Date(now).toISOString(), note });
      return;
    }
  }
}

// Scenario replays, bundled examples and the demo: nothing live to read, so
// the mitigation's recorded recovery after `since` stands in, padded with a
// quiet value to fill the window, one minute every 15 s. Never calls the
// live source.
async function replay(incident: Incident, v: Verification, check: Check): Promise<void> {
  const series = simulatedWindow(incident, v);
  // A window that starts now would end in the future: resolve it now.
  const notLater = (at: string) => (Date.parse(at) > Date.now() ? new Date().toISOString() : at);
  for (let n = 1; n <= series.length; n++) {
    await sleep(VERIFY_INTERVAL_MS);
    if (!(await check(series.slice(0, n), Date.now(), notLater))) return;
  }
}

// The minutes a replay shows: the recovery's recorded points after `since`,
// then a quiet value (the last one under the threshold, from the recovery
// or else the trigger's series before the breach) a minute apart, until
// there are windowMinutes of them.
export function simulatedWindow(incident: Incident, v: Pick<Verification, "since" | "threshold" | "windowMinutes">): MetricPoint[] {
  const recovery = incident.mitigation?.recovery?.series ?? [];
  const since = Date.parse(v.since);
  const series = recovery.filter((p) => Date.parse(p.t) > since).slice(0, v.windowMinutes);
  const under = (p: MetricPoint) => p.value < v.threshold;
  const quiet =
    recovery.findLast(under)?.value ?? incident.trigger.series.findLast(under)?.value ?? Math.round(v.threshold / 2);
  let t = Math.max(Math.floor(since / MINUTE) * MINUTE, ...series.map((p) => Date.parse(p.t)));
  while (series.length < v.windowMinutes) {
    t += MINUTE;
    series.push({ t: new Date(t).toISOString(), value: quiet });
  }
  return series;
}
