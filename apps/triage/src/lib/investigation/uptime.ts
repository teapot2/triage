import { stageModel, stageProblem } from "../models/settings";
import { notify } from "../notifications/notify";
import { runInvestigation } from "./agent";
import { incidentToReopen, isOpen } from "./reopen";
import type { Incident } from "./schema";
import type { TelemetrySource } from "./source";
import { getIncident, listIncidents, patchIncident } from "./store";
import {
  readChecks,
  incidentTitle,
  ruleDescription,
  ruleId,
  ruleName,
  ruleSeverity,
  type UptimeCheck,
  type UptimeRule,
  type UptimeSample,
} from "./uptime/checks";
import { createUptimeIncident } from "./uptime/incident";
import { judgeCheck } from "./uptime/judge";
import { probe } from "./uptime/probe";
import { appendSample, readSamples } from "./uptime/samples";
import { availabilityMetric, createUptimeSource } from "./uptime/source";
import { reopened, resolved } from "./verify";

// The uptime loop: Triage requests each configured URL itself (uptime/) and
// opens an incident when Slow or Down trips. Every TICK_MS it runs each
// enabled check whose interval has passed since its last sample, saves the
// sample and judges the check from its saved samples. A trip opens one
// incident for the whole episode, or reopens the one resolved within half
// an hour on the same rule and URL (see reopen); later failures only count
// on it (written at most once a minute), and a Slow episode whose endpoint
// then stops answering for the Down window becomes the Down incident. A run
// of healthyChecksToRecover ok samples resolves it, once its investigation
// has finished and no mitigation's verification is watching.
// startWatch and stopWatch run this loop with the rule watch.

const TICK_MS = 5000;
const MINUTE = 60_000;

export type EndpointState = {
  id: string;
  name: string;
  url: string;
  // alerting: its episode's incident is open. paused: the watch or the check
  // is off.
  status: "healthy" | "slow" | "unavailable" | "unchecked" | "alerting" | "paused";
  // "slow, check 2 of 3", "down 3 of 5 min", "200 in 184 ms".
  summary?: string;
  // A request is in flight.
  checking: boolean;
  last?: UptimeSample;
  slowStreak: number;
  downSince?: string;
  healthyStreak: number;
  // What each streak has to reach: slow checks to open Slow, minutes down
  // to open Down, healthy checks to resolve.
  needed: { slow: number; downMinutes: number; healthy: number };
  // The open episode's incident and the rule that opened it.
  incidentId?: string;
  rule?: UptimeRule;
  // Why the last trip opened nothing (no model to investigate with), or why
  // the last check failed to run.
  error?: string;
};

type Endpoint = {
  // As saved, newest last; read once, then kept from each append. Forgotten
  // when the check's URL changes: another target's results don't carry over.
  samples?: UptimeSample[];
  url?: string;
  inFlight: boolean;
  error?: string;
};

type Episode = {
  incidentId: string;
  rule: UptimeRule;
  // Failing checks since the incident was last written, and the newest:
  // written together at most once a minute (and before the incident
  // resolves), not on every check of a long outage.
  pending: number;
  lastFailedAt?: string;
  writtenAt: number;
};

const episode = (incidentId: string, rule: UptimeRule, now: number): Episode => ({ incidentId, rule, pending: 0, writtenAt: now });

type Internal = {
  version: number;
  enabled: boolean;
  timer?: ReturnType<typeof setInterval>;
  // The saved list as last read; undefined until then.
  checks?: UptimeCheck[];
  endpoints: Map<string, Endpoint>;
  // Per check id, the incident its open episode belongs to.
  episodes: Map<string, Episode>;
  // Episodes are rebuilt from the saved incidents once per process, so a
  // restart mid-outage opens nothing new.
  rebuilt?: Promise<void>;
};

// What the loop reaches outside itself, swapped in tests (uptimeForTests).
type Deps = {
  probe: (check: UptimeCheck) => Promise<UptimeSample>;
  now: () => number;
  notify: typeof notify;
  // Why the investigate stage can't run, or undefined when it can.
  investigationProblem: () => Promise<string | undefined>;
  investigate: (incident: Incident, source: TelemetrySource, appDir?: string) => Promise<unknown>;
};
const realDeps: Deps = {
  probe: (check) => probe(check),
  now: () => Date.now(),
  notify,
  investigationProblem: async () => stageProblem(await stageModel("investigate")),
  investigate: (incident, source, appDir) => runInvestigation(incident, source, { appDir }),
};
let deps = realDeps;

// On globalThis: one loop per server process, across dev hot reloads, the
// way watch.ts keeps its own. The timer calls whichever tick() was loaded
// last; a state from an older shape of this module is replaced, keeping
// whether the loop was on.
const VERSION = 1;
const g = globalThis as unknown as { triageUptime?: Internal; triageUptimeTick?: () => Promise<void> };
const fresh = (): Internal => ({ version: VERSION, enabled: false, endpoints: new Map(), episodes: new Map() });
let state = (() => {
  const old = g.triageUptime;
  if (old?.version === VERSION) return old;
  if (old?.timer) clearInterval(old.timer);
  g.triageUptime = fresh();
  if (old?.enabled) setTimeout(() => startUptime(), 0);
  return g.triageUptime;
})();
g.triageUptimeTick = tick;

export class UnknownCheck extends Error {}
export class CheckBusy extends Error {}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function startUptime() {
  if (state.timer) return;
  state.enabled = true;
  state.timer = setInterval(() => void g.triageUptimeTick?.(), TICK_MS);
  void tick();
}

// Episodes stay: they belong to incidents, which stay open while paused.
export function stopUptime() {
  if (state.timer) clearInterval(state.timer);
  Object.assign(state, { timer: undefined, enabled: false });
}

// After the list changes: read it again, and run what is due now rather
// than at the next tick.
export function recheckUptime() {
  if (state.enabled) void tick();
  else void load().catch((err) => console.error("[triage] uptime checks unreadable", err));
}

// Runs one check now, whatever its interval, and returns its sample. Acts
// on it like the loop does while the watch is on.
export async function checkNow(id: string): Promise<UptimeSample> {
  const check = (await load()).find((c) => c.id === id);
  if (!check) throw new UnknownCheck(`no uptime check ${id}`);
  if (state.enabled) await rebuildEpisodes();
  if (endpoint(id).inFlight) throw new CheckBusy(`${check.name} is being checked already`);
  return run(check);
}

export function uptimeState(): EndpointState[] {
  // Nothing read yet (the watch never started): the next poll has it.
  if (!state.checks) void load().catch((err) => console.error("[triage] uptime checks unreadable", err));
  const now = deps.now();
  return (state.checks ?? []).map((check) => {
    const e = endpoint(check.id);
    const j = judgeCheck(check, e.samples ?? [], now);
    const episode = state.episodes.get(check.id);
    const on = state.enabled && check.enabled;
    return {
      id: check.id,
      name: check.name,
      url: check.url,
      status: !on ? "paused" : episode ? "alerting" : j.status,
      summary: j.summary,
      checking: e.inFlight,
      last: e.samples?.at(-1),
      slowStreak: j.slowStreak,
      downSince: j.downSince,
      healthyStreak: j.healthyStreak,
      needed: { slow: check.slowChecksToOpen, downMinutes: check.downMinutesToOpen, healthy: check.healthyChecksToRecover },
      incidentId: episode?.incidentId,
      rule: episode?.rule,
      error: e.error,
    };
  });
}

function endpoint(id: string): Endpoint {
  let e = state.endpoints.get(id);
  if (!e) state.endpoints.set(id, (e = { inFlight: false }));
  return e;
}

// Reads the list and each check's samples not yet read; forgets checks
// that were removed.
async function load(): Promise<UptimeCheck[]> {
  const checks = await readChecks();
  const ids = new Set(checks.map((c) => c.id));
  for (const id of state.endpoints.keys()) if (!ids.has(id)) state.endpoints.delete(id);
  for (const id of state.episodes.keys()) if (!ids.has(id)) state.episodes.delete(id);
  await Promise.all(
    checks.map(async (c) => {
      const e = endpoint(c.id);
      if (e.url !== undefined && e.url !== c.url) {
        // The route dropped the old target's results; the open incident,
        // if any, was about that target and stays for a person to close.
        e.samples = [];
        state.episodes.delete(c.id);
      }
      e.url = c.url;
      e.samples ??= await readSamples(c.id);
    }),
  );
  state.checks = checks;
  return checks;
}

// The latest incident per check that its loop opened and nobody resolved.
// Not only the open statuses: a run cut off by a restart is failed, and its
// outage is still this episode.
function rebuildEpisodes(): Promise<void> {
  state.rebuilt ??= listIncidents().then(
    (incidents) => {
      const ids = new Set(state.checks?.map((c) => c.id));
      // Newest first, so the first per check wins.
      for (const i of incidents) {
        if (!i.uptime || i.status === "resolved" || !ids.has(i.uptime.checkId) || state.episodes.has(i.uptime.checkId)) continue;
        state.episodes.set(i.uptime.checkId, episode(i.id, i.uptime.rule, deps.now()));
      }
    },
    (err: unknown) => {
      state.rebuilt = undefined;
      throw err;
    },
  );
  return state.rebuilt;
}

async function tick() {
  if (!state.enabled) return;
  let checks: UptimeCheck[];
  try {
    checks = await load();
    await rebuildEpisodes();
  } catch (err) {
    console.error("[triage] uptime loop couldn't start a tick", err);
    return;
  }
  const now = deps.now();
  // Each check on its own: a slow one (up to its timeout) doesn't hold up
  // the others, and the next tick skips it while it is in flight.
  await Promise.all(
    checks
      .filter((c) => c.enabled && !endpoint(c.id).inFlight)
      .map((c) => {
        const last = endpoint(c.id).samples?.at(-1);
        if (!last || now - Date.parse(last.at) >= c.intervalSeconds * 1000) return run(c).catch(() => {});
        // Not due: a recovery that was waiting on the incident may go ahead.
        return settle(c).catch((err) => (endpoint(c.id).error = message(err)));
      }),
  );
}

// Probes, saves and judges one check, then acts on it while the loop is on.
// inFlight is set before anything is awaited, so a tick and a Check now
// can't both run it.
async function run(check: UptimeCheck): Promise<UptimeSample> {
  const e = endpoint(check.id);
  e.inFlight = true;
  try {
    const sample = await deps.probe(check);
    // Removed, or pointed elsewhere, while the request was out: the result
    // is nobody's.
    const current = state.checks?.find((c) => c.id === check.id);
    if (!current || current.url !== check.url) return sample;
    e.samples = await appendSample(check.id, sample);
    if (state.enabled && check.enabled) {
      // The sample stands either way; a failure to act on it stays on the
      // check, and the next sample tries again.
      e.error = await follow(check, e.samples).then(
        () => undefined,
        (err: unknown) => message(err),
      );
    }
    return sample;
  } catch (err) {
    e.error = message(err);
    throw err;
  } finally {
    e.inFlight = false;
  }
}

const failed = (s: UptimeSample | undefined) => s !== undefined && s.outcome !== "ok";

// The incident for this check's episode, or undefined once there is none:
// the episode ends when its incident was resolved (by a person, or by a
// verification) or deleted.
async function episodeIncident(check: UptimeCheck): Promise<Incident | undefined> {
  const episode = state.episodes.get(check.id);
  if (!episode) return undefined;
  const incident = await getIncident(episode.incidentId);
  if (incident && incident.status !== "resolved") return incident;
  state.episodes.delete(check.id);
  return undefined;
}

// Acts on a new sample: counts a failure on the open episode, resolves it
// after a healthy run, or opens one when a rule trips.
async function follow(check: UptimeCheck, samples: UptimeSample[]) {
  const now = deps.now();
  const last = samples.at(-1)!;
  const incident = await episodeIncident(check);
  const { trip } = judgeCheck(check, samples, now);
  if (incident) {
    const ep = state.episodes.get(check.id)!;
    if (failed(last)) {
      ep.pending++;
      ep.lastFailedAt = last.at;
      if (ep.rule === "slow" && trip === "down") await escalate(check, ep, samples, now);
      else if (now - ep.writtenAt >= MINUTE) await writeFailures(check, ep, now);
    } else {
      await settle(check);
    }
    return;
  }
  if (trip) await open(check, trip, samples, now);
}

// Writes the episode's failing checks since the last write onto its incident:
// the page says how long it has been failing, and a recovery seen while it
// waited on the investigation no longer stands.
async function writeFailures(check: UptimeCheck, ep: Episode, now: number) {
  if (ep.pending === 0) return;
  const { pending, lastFailedAt } = ep;
  await patchIncident(ep.incidentId, (i) => ({
    ...i,
    uptime: {
      ...(i.uptime ?? { checkId: check.id, rule: ep.rule }),
      failedChecks: (i.uptime?.failedChecks ?? 0) + pending,
      lastFailedAt,
      recoveredAt: undefined,
    },
  }));
  ep.pending = 0;
  ep.writtenAt = now;
}

// A Slow episode whose endpoint has now stopped answering for the whole Down
// window is the outage, not a slowdown: the same incident becomes the Down
// one (sev2, titled and charted as Down would have opened it), so nothing
// opens twice and nobody reads a full outage as "slow responses".
async function escalate(check: UptimeCheck, ep: Episode, samples: UptimeSample[], now: number) {
  const { source } = await createUptimeSource(check, samples, { now });
  const metric = availabilityMetric(check);
  const alert = await source.queryMetric({ name: metric, windowMinutes: 60 });
  if (!alert || alert.points.length === 0) return;
  const { pending, lastFailedAt } = ep;
  const incident = await patchIncident(ep.incidentId, (i) => ({
    ...i,
    title: incidentTitle(check, "down"),
    severity: ruleSeverity("down"),
    trigger: {
      ...i.trigger,
      metric,
      unit: alert.unit,
      threshold: 100,
      observed: alert.points[alert.points.length - 1].value,
      series: alert.points,
      rule: { id: ruleId(check, "down"), name: `${check.name} ${ruleName("down")}`, description: ruleDescription(check, "down") },
    },
    uptime: {
      ...(i.uptime ?? { checkId: check.id, rule: ep.rule }),
      rule: "down",
      failedChecks: (i.uptime?.failedChecks ?? 0) + pending,
      lastFailedAt,
      recoveredAt: undefined,
    },
  }));
  Object.assign(ep, { rule: "down", pending: 0, writtenAt: now });
  console.log(`[triage] uptime check ${check.id} stopped answering; ${incident.id} is now the Down incident`);
}

// Resolves the episode's incident once the check has answered in time
// healthyChecksToRecover times in a row. It waits while the investigation
// is still running (recording when recovery was confirmed) and while a
// mitigation's verification is watching (that loop resolves it).
async function settle(check: UptimeCheck) {
  const samples = endpoint(check.id).samples ?? [];
  const { healthyStreak } = judgeCheck(check, samples, deps.now());
  if (healthyStreak < check.healthyChecksToRecover || !state.episodes.has(check.id)) return;
  const ep = state.episodes.get(check.id)!;
  await writeFailures(check, ep, deps.now());
  const incident = await episodeIncident(check);
  if (!incident || incident.verification?.status === "verifying") return;

  const healthy = samples.slice(-healthyStreak);
  const at = healthy.at(-1)!.at;
  // A run still going gets its say first; one that failed (a model error, a
  // restart) never will, and the outage ending is still the outage ending.
  const waiting = (i: Incident) => i.status === "investigating";
  if (waiting(incident)) {
    if (!incident.uptime?.recoveredAt) {
      await patchIncident(incident.id, (i) => (i.uptime ? { ...i, uptime: { ...i.uptime, recoveredAt: at } } : i));
    }
    return;
  }

  const finishedAt = new Date(deps.now()).toISOString();
  const since = healthy[0].at;
  const saved = await patchIncident(incident.id, (i) => {
    // Checked again on the saved incident: it may have moved on meanwhile.
    if (i.status === "resolved" || waiting(i) || i.verification?.status === "verifying") return i;
    const windowMinutes = Math.max(1, Math.round((Date.parse(at) - Date.parse(since)) / MINUTE));
    // In the incident's own metric, so the chart and the header read it: a
    // Down incident charts availability, where each healthy check is 100 %.
    const availability = i.trigger.metric.startsWith("uptime.availability");
    return resolved(
      {
        ...i,
        uptime: i.uptime && { ...i.uptime, recoveredAt: i.uptime.recoveredAt ?? at },
        verification: {
          after: "uptime",
          since,
          windowMinutes,
          metric: i.trigger.metric,
          threshold: i.trigger.threshold,
          series: healthy.map((s) => ({ t: s.at, value: availability ? 100 : s.ms })),
          status: "resolved",
          startedAt: since,
          checkedAt: finishedAt,
          finishedAt,
        },
      },
      at,
    );
  });
  if (saved.status !== "resolved") return;
  state.episodes.delete(check.id);
  console.log(`[triage] uptime check ${check.id} recovered; resolved ${saved.id}`);
  // Keyed on the resolution's time: once, whoever resolved it.
  deps.notify("resolved", saved);
}

// Opens the episode's incident and starts its investigation, or reopens
// the one resolved shortly before on the same rule and URL. Throws (the
// error goes on the check, and the next sample tries again) when no model
// can investigate.
async function open(check: UptimeCheck, rule: UptimeRule, samples: UptimeSample[], now: number) {
  const at = new Date(now).toISOString();
  const last = samples.at(-1)!;
  let failing = 0;
  for (let i = samples.length - 1; i >= 0 && failed(samples[i]); i--) failing++;

  const previous = incidentToReopen(await listIncidents(), { ruleId: ruleId(check, rule), route: check.url }, now);
  if (previous) {
    const incident = await patchIncident(previous.id, (i) => ({
      // Already reopened (its verification saw the failure first): the
      // episode joins it as it is.
      ...(isOpen(i) ? i : reopened(i, { at, by: "watch", why: `${incidentTitle(check, rule)} again` })),
      uptime: { checkId: check.id, rule, failedChecks: (i.uptime?.failedChecks ?? 0) + failing, lastFailedAt: last.at },
    }));
    state.episodes.set(check.id, episode(incident.id, rule, now));
    console.log(`[triage] uptime check ${check.id} reopened ${incident.id}`);
    deps.notify("incident_reopened", incident);
    return;
  }

  const problem = await deps.investigationProblem();
  if (problem) throw new Error(`${problem} No incident was opened.`);
  const { source, appDir } = await createUptimeSource(check, samples, { now });
  const incident = await createUptimeIncident(check, rule, samples, source);
  state.episodes.set(check.id, episode(incident.id, rule, now));
  console.log(`[triage] uptime check ${check.id} opened ${incident.id}: ${incident.title}`);
  // Slack hears within the tick, before the investigation starts.
  deps.notify("incident_opened", incident);
  // The pipeline runs on its own; the loop keeps checking meanwhile.
  void deps.investigate(incident, source, appDir);
}

// For tests: the loop as a new process starts it (nothing in memory, so
// episodes are rebuilt from the saved incidents), on, with `replace` swapped
// in, and ticking only when told to.
export const uptimeForTests = {
  restart(replace: Partial<Deps> = {}) {
    if (state.timer) clearInterval(state.timer);
    state = g.triageUptime = { ...fresh(), enabled: true };
    deps = { ...realDeps, ...replace };
  },
  tick: () => tick(),
};
