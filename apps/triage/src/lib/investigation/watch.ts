import { liveService } from "../live/types";
import { investigationProblem } from "../models/settings";
import { notify } from "../notifications/notify";
import { evaluateSloRule } from "../slo/judge";
import { burnRate } from "../slo/model";
import { type CountsFn, liveCounts, rolledThrough, routesSince } from "../slo/rollups";
import { createRuleIncident, runInvestigation } from "./agent";
import { isArchived } from "./archive";
import { type DependencyState, dependencyState, startDependencies, stopDependencies } from "./dependencies";
import { type LastOpened, lastOpened, recordOpened } from "./last-opened";
import { createLiveSource, type RequestSample, recentRequests, sampleStatements, shopfrontDir } from "./live/live-source";
import { RETENTION_MS } from "./live/otlp-files";
import { mitigationInEffect } from "./mitigation/in-effect";
import { incidentToReopen, isOpen } from "./reopen";
import type { Incident } from "./schema";
import { getIncident, isExample, listIncidents, patchIncident } from "./store";
import { type EndpointState, startUptime, stopUptime, uptimeState } from "./uptime";
import { reopened } from "./verify";
import { CHECK_MS, evaluateRule, HEALTHY_TO_REARM, isWatched, newFastBurn, type RuleResult } from "./watch-judge";
import { describeRule, readRules, type WatchRule } from "./watch-rules";
import { errorMessage } from "../errors";

// Stage 1: Triage watches the live store and opens an incident on its own.
// Every CHECK_MS it judges each watch rule (see watch-rules) on the real
// requests in the rule's window, route by route. A rule over its limit on a
// route for checksToOpen checks in a row opens one incident and starts the
// whole pipeline (investigate, fix, prove); a single slow blip doesn't.
//
// Each rule then has an episode: it stays quiet whatever it trips on, and
// re-arms once it has been within its limit for HEALTHY_TO_REARM judged
// checks, so one outage is one incident. Another rule tripping on the same
// outage joins that incident rather than opening its own: in the same check
// (latency and errors together, the most severe opening it), or within
// JOIN_WINDOW_MS of the incident opening while a rule in it is still over
// its limit. An SLO's fast alert can judge a quiet route minutes late, after
// the outage's other rules re-armed: it joins their incident when the
// minutes it burns on overlap that incident's breach (lateJoinable). A rule
// that trips later, or while the open episodes are only an outage's tail
// (an SLO's slow burn, for hours after), opens its own. An SLO rule's own
// tail doesn't hide a new outage either: a fast alert after
// FAST_BURN_QUIET_MS without one ends its episode and starts the next
// (newFastBurn), while a fast alert that flaps stays in it. A breach within
// half an hour of an incident on the same rule and route being resolved
// reopens that incident instead of opening another (see reopen), unless
// that incident's mitigation still holds: then the old cause is held off,
// and the breach opens a new incident, investigated, linked to the old one
// (relatedTo). A restart rebuilds the episodes from the incidents nobody
// resolved, so an outage still going opens nothing new. How a rule is
// judged is in watch-judge, shared with the backtest; an SLO rule, on how
// fast its error budget burns, in slo/judge, from the request counts
// slo/rollups keeps.

// The window the sidebar's request count covers.
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// How long after an incident opens another rule's trip can join it, while a
// rule in it is still over its limit. The rules judge a minute or two of
// requests (an SLO's fast alert, 5 minutes in its short window), so one
// outage reaches them all within a few minutes of each other, its ramp
// included; a fault that starts ten minutes into another is announced as
// its own rather than filed under it.
export const JOIN_WINDOW_MS = 10 * MINUTE;

export type RuleStatus = "ok" | "breaching" | "alerting" | "idle" | "paused";

export type RuleState = {
  id: string;
  name: string;
  // The rule in a line: "p95 over 500 ms on each API route".
  description: string;
  // alerting: its episode's incident is open, whether it opened it or
  // joined another rule's.
  status: RuleStatus;
  // What its route nearest (or furthest past) the limit measured at the last
  // check: "p95 14 ms on /api/products/[id]".
  summary?: string;
  // While breaching: checks in a row over the limit, of the number that
  // opens an incident.
  checks?: number;
  needed: number;
  // An SLO rule's: what's left of its error budget on its worst route.
  budgetLeftPercent?: number;
  // While alerting: its episode's incident.
  incidentId?: string;
};

export type WatchState = {
  enabled: boolean;
  // ok: every rule within its limits. breaching: a rule over its limit, not
  // yet sustained. alerting: a rule's episode has an incident open. idle:
  // too little traffic to judge any rule.
  status: "ok" | "breaching" | "alerting" | "idle" | "paused";
  rules: RuleState[];
  // Requests the rules saw in the last minute, every watched route together.
  lastCheck?: { at: string; requests: number };
  // The incident the watch last opened or reopened, from any of its loops
  // (rules, uptime checks, the dependency audit; see last-opened).
  lastOpened?: LastOpened;
  // While alerting: the incident of the newest open episode.
  incidentId?: string;
  error?: string;
  // What failed: the check itself, or opening the incident a rule tripped
  // (no model configured, say). The sidebar words the two differently.
  errorKind?: "check" | "open";
  // The uptime checks (see uptime), which start and pause with the watch.
  endpoints: EndpointState[];
  // The dependency audit (see dependencies), which does too.
  dependencies: DependencyState;
};

// A rule's episode: from its trip until it re-arms.
type Episode = {
  // The incident it belongs to: one the rule opened or reopened, or another
  // rule's it joined.
  incidentId: string;
  // When that incident opened, or was reopened, for this outage. Joins are
  // timed from it, so an incident takes in other rules only near its start.
  openedAt: number;
  // The rule's judged checks in a row within its limit; 0 while it's over.
  healthy: number;
  // Rebuilt after a restart from an incident nobody resolved, and the rule
  // hasn't tripped since: it isn't alerting and nothing joins it, but the
  // rule's next trip joins its incident (the outage still going) instead of
  // opening one. Gone like any episode once the rule re-arms, so an old
  // incident left open shows nothing on a healthy service.
  waiting?: boolean;
  // An SLO rule's: when its fast alert last fired in this episode, or
  // undefined if it hasn't (a slow burn opened it). A fast alert after
  // FAST_BURN_QUIET_MS without one starts the rule's next episode.
  fastAt?: number;
  // Rebuilt after a restart, before the rule's first judged check: whether
  // its fast alert was firing before the restart isn't known. A fast alert
  // at that first check is the outage still going, and stays in the
  // episode; otherwise it was quiet, and counts as last firing when the
  // incident opened (fastAt = openedAt), so a fast burn more than
  // FAST_BURN_QUIET_MS after that opens a new incident.
  fastUnknown?: boolean;
  // When the breach it tripped on began, as far as its rule saw (its window
  // back from its first check over), and its rule's last check over its
  // limit since. An SLO's late trip joins the incident when the minutes it
  // burns on fall between the two (lateJoinable). Missing on a rebuilt
  // episode, which nothing joins late.
  from?: number;
  overAt?: number;
};

type Internal = Omit<WatchState, "rules" | "endpoints" | "dependencies"> & {
  version: number;
  timer?: ReturnType<typeof setInterval>;
  checking: boolean;
  // Here, the incident the rules last opened or reopened; watchState's
  // lastOpened is the newest from any loop.
  lastOpened?: LastOpened;
  // Checks in a row over the limit, per rule and route ("api-latency|/api/x"),
  // and when an SLO's slow burn started firing ("api-slo|/api/x|slow").
  streaks: Map<string, number>;
  // Per rule id, its open episode. Kept while the watch is paused: they
  // belong to incidents, which stay open.
  episodes: Map<string, Episode>;
  // Episodes that re-armed within JOIN_WINDOW_MS of their incident opening,
  // kept until that window ends: an SLO's late trip can still join them.
  ended: Episode[];
  // Episodes are rebuilt from the saved incidents once per process.
  rebuilt?: Promise<void>;
  rules: RuleState[];
  // The routes the SLO rules judge, beyond those in the telemetry: every
  // route counted over the longest SLO window, read at most once a minute.
  sloRoutes?: { at: number; since: number; routes: { route: string; method: string }[] };
};

// An SLO's fast trip also says which minutes it is burning on
// (burningMinutes): the newest run of minutes each past the alert's
// threshold on its own, from the first one's start to the last one's end.
// Missing when no minute of its short window did (the burn spread thin), and
// on every other trip. Its incident keeps them (trigger.burn.burning), for
// the investigation's brief and the off-flag check.
type Trip = NonNullable<RuleResult["trip"]> & { burning?: { from: number; to: number } };
type Result = Omit<RuleResult, "trip"> & { trip?: Trip };

// What the watch reaches outside itself, swapped in tests (watchForTests).
type Deps = {
  now: () => number;
  readRules: () => Promise<WatchRule[]>;
  // Judges each rule at `now`, in the rules' order, advancing `streaks`;
  // and the requests the rules saw in the last minute.
  judge: (rules: WatchRule[], now: number, streaks: Map<string, number>) => Promise<{ requests: number; results: Result[] }>;
  notify: typeof notify;
  // Why an investigation can't start, or undefined when it can.
  investigationProblem: () => Promise<string | undefined>;
  // Saves a new incident for the trip; `investigate` starts its pipeline.
  createIncident: (
    rule: WatchRule,
    trip: Trip,
    relatedTo?: Incident["relatedTo"],
  ) => Promise<{ incident: Incident; investigate: () => Promise<unknown> }>;
  // Whether an incident's mitigation still holds (mitigation/in-effect).
  mitigationInEffect: (incident: Incident) => Promise<boolean | undefined>;
};
const realDeps: Deps = {
  now: () => Date.now(),
  readRules,
  judge: (rules, now, streaks) => judgeRules(rules, now, streaks),
  notify,
  investigationProblem,
  createIncident: async (rule, trip, relatedTo) => {
    const source = await createLiveSource();
    const incident = await createRuleIncident(source, { rule, ...trip }, relatedTo);
    return { incident, investigate: () => runInvestigation(incident, source, { appDir: shopfrontDir }) };
  },
  mitigationInEffect,
};
let deps = realDeps;

// On globalThis: one watcher per server process, across dev hot reloads.
// The timer calls whichever check() was loaded last, so an edit to this
// file takes effect without a restart. A state from an older shape of this
// module is replaced, keeping whether the watch was on.
const VERSION = 4;
const g = globalThis as unknown as { triageWatch?: Internal; triageWatchCheck?: () => Promise<void> };
const fresh = (): Internal => ({
  version: VERSION,
  enabled: false,
  status: "paused",
  checking: false,
  streaks: new Map(),
  episodes: new Map(),
  ended: [],
  rules: [],
});
let state = (() => {
  const old = g.triageWatch;
  if (old?.version === VERSION) return old;
  if (old?.timer) clearInterval(old.timer);
  g.triageWatch = fresh();
  if (old?.enabled) setTimeout(() => startWatch(), 0);
  return g.triageWatch;
})();
g.triageWatchCheck = check;

export function watchState(): WatchState {
  const { enabled, status, lastCheck, error, errorKind } = state;
  const rules = enabled ? state.rules : state.rules.map((r) => ({ ...r, status: "paused" as const, summary: undefined }));
  const incidentId = status === "alerting" ? state.incidentId : undefined;
  return {
    enabled,
    status,
    rules,
    lastCheck,
    lastOpened: lastOpened() ?? state.lastOpened,
    incidentId,
    error,
    ...(error && { errorKind }),
    endpoints: uptimeState(),
    dependencies: dependencyState(),
  };
}

export function startWatch() {
  if (state.timer) return;
  Object.assign(state, { enabled: true, status: "idle", error: undefined });
  state.streaks.clear();
  state.timer = setInterval(() => void g.triageWatchCheck?.(), CHECK_MS);
  void check();
  startUptime();
  startDependencies();
}

export function stopWatch() {
  if (state.timer) clearInterval(state.timer);
  Object.assign(state, { timer: undefined, enabled: false, status: "paused" });
  state.streaks.clear();
  stopUptime();
  stopDependencies();
}

// Checks now rather than at the next tick: after the rules change.
export function recheckWatch() {
  void check();
}

const severityRank = { sev1: 0, sev2: 1, sev3: 2, sev4: 3 } as const;

type Judged = { rule: WatchRule } & Result;

async function check() {
  // A slow read (a big telemetry file after a restart) must not overlap
  // the next tick.
  if (state.checking || !state.enabled) return;
  state.checking = true;
  try {
    const rules = await deps.readRules();
    const now = deps.now();
    await rebuildEpisodes(rules.map((r) => r.id));
    const judged = await deps.judge(rules, now, state.streaks);
    state.lastCheck = { at: new Date(now).toISOString(), requests: judged.requests };
    state.error = undefined;
    const results = rules.map((rule, i): Judged => ({ rule, ...judged.results[i] }));

    // Each episode ends once its rule has been within its limit for
    // HEALTHY_TO_REARM judged checks; a removed rule's, at once. An SLO
    // rule's fresh fast burn (newFastBurn) ends it too, below, once the
    // next one has its incident.
    for (const id of state.episodes.keys()) if (!rules.some((r) => r.id === id)) state.episodes.delete(id);
    state.ended = state.ended.filter((e) => now - e.openedAt <= JOIN_WINDOW_MS);
    const leaving = new Map<string, Episode>();
    for (const r of results) {
      const episode = state.episodes.get(r.rule.id);
      if (!episode) continue;
      if (r.rule.condition.metric === "slo" && (r.status === "ok" || r.status === "breaching")) {
        const fast = r.trip?.speed === "fast";
        if (episode.fastUnknown) {
          episode.fastUnknown = undefined;
          episode.fastAt = fast ? now : episode.openedAt;
        } else if (newFastBurn(r.trip, episode.fastAt, now)) leaving.set(r.rule.id, episode);
        else if (fast) episode.fastAt = now;
      }
      if (r.status === "breaching") {
        episode.healthy = 0;
        if (!episode.waiting) episode.overAt = now;
      } else if (r.status === "ok" && ++episode.healthy >= HEALTHY_TO_REARM) rearm(r.rule.id);
    }

    // Several at once (latency and errors in the same outage): the most
    // severe opens the incident, ties going to the rule listed first, and
    // the rest join it. A slow burn's trip carries its own, lower severity.
    // A rule already in an episode trips into it, quietly, unless it's
    // leaving it for a new outage.
    const rank = (r: Judged) => severityRank[r.trip?.severity ?? r.rule.severity];
    const trips = results
      .filter((r) => r.trip && (!alerting(r.rule.id) || leaving.has(r.rule.id)))
      .sort((a, b) => rank(a) - rank(b));
    for (const r of trips) {
      await trip(r.rule, r.trip!, r.summary, now, leaving.get(r.rule.id));
      // Paused while it opened: the pause stands.
      if (!state.enabled) return;
    }

    const breaching = results.some((r) => r.status === "breaching");
    const anyOk = results.some((r) => r.status === "ok");
    // Alerting while an enabled rule's episode has its incident open. If it
    // can't be opened, the rule stays breaching, so the next check tries
    // again and the error stays up.
    const open = results.filter((r) => r.rule.enabled && alerting(r.rule.id));
    const newest = open
      .map((r) => state.episodes.get(r.rule.id)!)
      .sort((a, b) => b.openedAt - a.openedAt)[0];
    state.incidentId = newest?.incidentId;
    state.status = newest ? "alerting" : breaching ? "breaching" : anyOk ? "ok" : "idle";

    state.rules = results.map((r): RuleState => {
      const on = r.status !== "paused" && alerting(r.rule.id);
      return {
        id: r.rule.id,
        name: r.rule.name,
        description: describeRule(r.rule),
        status: on ? "alerting" : r.status,
        summary: r.summary,
        checks: r.checks,
        needed: r.rule.condition.metric === "slo" ? 1 : r.rule.checksToOpen,
        budgetLeftPercent: r.budgetLeftPercent,
        ...(on && { incidentId: state.episodes.get(r.rule.id)!.incidentId }),
      };
    });
  } catch (err) {
    state.error = errorMessage(err);
    state.errorKind = "check";
  } finally {
    state.checking = false;
  }
}

const alerting = (ruleId: string) => {
  const episode = state.episodes.get(ruleId);
  return episode !== undefined && !episode.waiting;
};

// Ends a rule's episode: its next trip is a new outage. Its streaks go with
// it, so a route that went quiet mid-breach starts again from nothing. An
// episode its rule tripped is kept a while for a late SLO trip (ended).
function rearm(ruleId: string) {
  const episode = state.episodes.get(ruleId);
  if (episode && !episode.waiting && episode.overAt !== undefined) state.ended.push(episode);
  state.episodes.delete(ruleId);
  for (const key of state.streaks.keys()) if (key.startsWith(`${ruleId}|`)) state.streaks.delete(key);
}

// A rule tripped outside an episode: it joins the incident it waited on
// after a restart, or another rule's that opened on the same outage, or
// opens (or reopens) its own. `leaving`: the SLO rule's episode a fresh fast
// burn ends (newFastBurn). Its incident is the old outage's, so the trip
// neither waits on it nor joins it, and the episode stands until the next
// one has an incident: if none can be opened, the next check tries again.
async function trip(rule: WatchRule, tripped: Trip, summary: string | undefined, now: number, leaving?: Episode) {
  const fastAt = tripped.speed === "fast" ? now : undefined;
  // Where this rule's breach began, and that it's over now: for late joins.
  const breach = { from: breachFrom(rule, tripped, now), overAt: now };
  const waiting = leaving ? undefined : state.episodes.get(rule.id);
  if (waiting) {
    // The incident it waited on may have been resolved or archived since.
    const incident = await getIncident(waiting.incidentId);
    if (incident && incident.status !== "resolved" && !isArchived(incident)) {
      state.episodes.set(rule.id, { ...waiting, waiting: undefined, healthy: 0 });
      console.log(`[triage] watch rule ${rule.id} tripped again after a restart; still ${incident.id}`);
      return;
    }
    state.episodes.delete(rule.id);
  }

  if (leaving) console.log(`[triage] watch rule ${rule.id} burning fast again after ${leaving.incidentId}: a new outage`);
  const joined = (await joinable(now, leaving?.incidentId)) ?? (await lateJoinable(rule, tripped, now, leaving?.incidentId));
  if (joined) {
    state.episodes.set(rule.id, { incidentId: joined.incidentId, openedAt: joined.openedAt, healthy: 0, fastAt, ...breach });
    // On the incident too, so a restart puts the rule back in its episode.
    // The episode stands without it.
    const at = new Date(now).toISOString();
    await patchIncident(joined.incidentId, (i) => ({
      ...i,
      joinedRules: [...(i.joinedRules ?? []).filter((j) => j.id !== rule.id), { id: rule.id, name: rule.name, at }],
    })).catch((err: unknown) => console.error(`[triage] couldn't note ${rule.id} on ${joined.incidentId}`, err));
    console.log(`[triage] watch rule ${rule.id} joined ${joined.incidentId}`);
    return;
  }

  const incident = await open(rule, tripped, summary, now).catch((err: unknown) => {
    state.error = `Couldn't open an incident: ${errorMessage(err)}`;
    state.errorKind = "open";
    return undefined;
  });
  if (incident) state.episodes.set(rule.id, { incidentId: incident.id, openedAt: now, healthy: 0, fastAt, ...breach });
}

// When the breach a trip at `now` is on began, as far as its rule saw: an
// SLO's, its first burning minute (else its short window's start); any
// other rule's, its window back from its first check over the limit.
function breachFrom(rule: WatchRule, tripped: Trip, now: number): number {
  if (rule.condition.metric === "slo") return tripped.burning?.from ?? now - (tripped.burn?.shortMs ?? 0);
  return now - rule.windowSeconds * 1000 - (rule.checksToOpen - 1) * CHECK_MS;
}

// The episode a trip at `now` joins: one whose incident opened in the last
// JOIN_WINDOW_MS and whose rule was over its limit at its last judged
// check, the newest if several, on an incident other than `left`. None for
// an outage's tail: its incident is older than that. Never a resolved or
// archived incident: joining one is silent (nothing opens or notifies, and
// it stays resolved), so a new breach must go through open(), which
// reopens it or, while its mitigation holds, opens a new one. On Nov 4 the
// price gap's Server errors joined the pool leak's incident 2 min after it
// resolved (its API SLO's slow-burn tail still over its limit) and paged
// nobody for 16 minutes.
async function joinable(now: number, left?: string): Promise<Episode | undefined> {
  const candidates = [...state.episodes.values()]
    .filter((e) => !e.waiting && e.healthy === 0 && now - e.openedAt <= JOIN_WINDOW_MS && e.incidentId !== left)
    .sort((a, b) => b.openedAt - a.openedAt);
  for (const e of candidates) {
    const incident = await getIncident(e.incidentId);
    if (incident && incident.status !== "resolved" && !isArchived(incident)) return e;
  }
  return undefined;
}

// The episode an SLO's fast trip at `now` joins though its rule is back
// within its limit, or has re-armed: one whose incident opened in the last
// JOIN_WINDOW_MS, and whose breach (from its start to its rule's last check
// over) overlaps the minutes the SLO is burning on. The SLO's fast alert
// judges a route only once its short window holds enough requests (70 in
// 5 min at 99.9% over 30 days), so on a quiet route, or with traffic just
// back, it fires minutes after the outage's other rules tripped, on the same
// bad minutes: on Nov 3 it opened a second incident for the price gap
// 2.5 min after Server errors had opened one. A slow burn never joins late:
// its 6 h short window overlaps anything. Nor does a burn that started
// after the other breach ended: that's a fault of its own. The newest if
// several, on an incident other than `left` and another rule's (the SLO's
// own re-armed episode opens anew, as before), neither resolved nor
// archived.
async function lateJoinable(rule: WatchRule, tripped: Trip, now: number, left?: string): Promise<Episode | undefined> {
  if (rule.condition.metric !== "slo" || tripped.speed !== "fast" || !tripped.burn) return undefined;
  const burning = tripped.burning ?? { from: now - tripped.burn.shortMs, to: now };
  const candidates = [...state.episodes.values(), ...state.ended]
    .filter(
      (e) =>
        !e.waiting &&
        e.from !== undefined &&
        e.overAt !== undefined &&
        now - e.openedAt <= JOIN_WINDOW_MS &&
        e.incidentId !== left &&
        burning.from <= e.overAt &&
        burning.to >= e.from,
    )
    .sort((a, b) => b.openedAt - a.openedAt);
  for (const e of candidates) {
    const incident = await getIncident(e.incidentId);
    if (incident && incident.trigger.rule?.id !== rule.id && incident.status !== "resolved" && !isArchived(incident)) {
      console.log(`[triage] watch rule ${rule.id} burning on the outage of ${e.incidentId}, minutes late`);
      return e;
    }
  }
  return undefined;
}

// Per rule, the newest incident it opened or joined that nobody resolved,
// as an episode waiting for the rule to trip (see Episode). Not only the
// open statuses: a run cut off by a restart is failed, and its outage is
// still this episode. Once per process, before the first check acts.
function rebuildEpisodes(ruleIds: string[]): Promise<void> {
  state.rebuilt ??= listIncidents().then(
    (incidents) => {
      const ids = new Set(ruleIds);
      const newest = new Map<string, Episode>();
      for (const i of incidents) {
        if (i.openedBy !== "watch" || i.uptime || i.dependency || isExample(i.id) || i.status === "resolved" || isArchived(i)) continue;
        const openedAt = Math.max(Date.parse(i.detectedAt), ...(i.reopenings ?? []).map((r) => Date.parse(r.at)));
        for (const id of [i.trigger.rule?.id, ...(i.joinedRules ?? []).map((j) => j.id)]) {
          if (!id || !ids.has(id) || (newest.get(id)?.openedAt ?? -1) >= openedAt) continue;
          newest.set(id, { incidentId: i.id, openedAt, healthy: 0, waiting: true, fastUnknown: true });
        }
      }
      for (const [id, episode] of newest) if (!state.episodes.has(id)) state.episodes.set(id, episode);
    },
    (err: unknown) => {
      state.rebuilt = undefined;
      throw err;
    },
  );
  return state.rebuilt;
}

// The live judge: each rule on the real requests in its window, an SLO rule
// on the request counts plus the requests since the last minute written.
async function judgeRules(rules: WatchRule[], now: number, streaks: Map<string, number>) {
  // The database's statement counters, for slow_queries' window (see
  // live-source). Not awaited: a slow database must not delay the check.
  void sampleStatements(now);
  const slos = rules.filter((r) => r.enabled && r.condition.metric === "slo");
  // SLO rules count the requests since the minutes rolled up, or every one
  // in the telemetry before any are.
  const through = rolledThrough();
  const unrolled = slos.length ? now - (through ?? now - RETENTION_MS) : 0;
  const longest = Math.max(MINUTE, unrolled, ...rules.map((r) => r.windowSeconds * 1000));
  const samples = (await recentRequests(longest)).filter(isWatched);
  const sloRoutes = slos.length ? routesToJudge(samples, slos, now) : [];
  const counts = liveCounts(liveService, samples, through);
  return {
    requests: samples.filter((s) => s.start > now - MINUTE).length,
    results: rules.map((rule): Result => {
      if (rule.condition.metric !== "slo") return evaluateRule(rule, samples, now, streaks);
      const result = evaluateSloRule(rule, sloRoutes, counts, now, streaks);
      const trip = result.trip;
      if (trip?.speed !== "fast") return result;
      return { ...result, trip: { ...trip, burning: burningMinutes(counts, rule, trip, now) } };
    }),
  };
}

// The minutes a fast trip is burning on: the newest run of whole minutes
// whose own burn is past the alert's threshold, from the newest such minute
// in its short window back to the minute the run began (as far back as its
// long window), or undefined if no minute of the short window burns on its
// own. A stray slow request doesn't make a minute burn; a minute of the
// outage does. Only the newest run: on Nov 4 the 6× alert's 30 min window
// held the pool leak's minutes (03:24 to 03:25) and the price gap's (03:32 to
// 03:48), and first to last made one span of the two. Back past the short
// window, so the run says when this burn began (03:32), not just its last
// minutes. A run outlasts up to RUN_GAP_MINUTES clean minutes in a row (an
// idle one counts as clean): the price gap fails only the products without
// a price row, 1 to 8 requests of 12 to 41 a minute, and 03:46 had none;
// the two outages were 6 clean minutes apart.
const RUN_GAP_MINUTES = 2;
export function burningMinutes(counts: CountsFn, rule: WatchRule, trip: Trip, now: number): Trip["burning"] {
  const c = rule.condition;
  if (c.metric !== "slo" || !trip.burn) return undefined;
  const { threshold, shortMs, longMs } = trip.burn;
  const burns = (m: number) =>
    burnRate(counts(trip.route, m, Math.min(m + MINUTE, now), c.latencyMs), c.objectivePercent) > threshold;
  const minuteOf = (t: number) => Math.floor(t / MINUTE) * MINUTE;
  let newest = minuteOf(now - 1);
  while (newest >= minuteOf(now - shortMs) && !burns(newest)) newest -= MINUTE;
  if (newest < minuteOf(now - shortMs)) return undefined;
  let from = newest;
  for (let m = newest - MINUTE, clean = 0; m >= minuteOf(now - longMs) && clean <= RUN_GAP_MINUTES; m -= MINUTE) {
    if (burns(m)) [from, clean] = [m, 0];
    else clean++;
  }
  return { from, to: Math.min(newest + MINUTE, now) };
}

// The routes the SLO rules judge: those in the telemetry, with the method of
// their latest request, and those counted over the longest SLO window, so a
// route with no traffic just now still has its budget judged.
function routesToJudge(samples: RequestSample[], slos: WatchRule[], now: number) {
  const days = Math.max(...slos.map((r) => (r.condition.metric === "slo" ? r.condition.windowDays : 0)));
  const since = now - days * DAY;
  const cached = state.sloRoutes;
  if (!cached || cached.since > since || now - cached.at >= MINUTE) {
    state.sloRoutes = { at: now, since, routes: routesSince(liveService, since) };
  }
  const methods = new Map(state.sloRoutes!.routes.map((r) => [r.route, r.method]));
  for (const s of samples) if (s.service === liveService) methods.set(s.route, s.method);
  return [...methods].map(([route, method]) => ({ route, method }));
}

// Opens the incident and starts its run; undefined when no model can run
// it. The same outage back soon after a resolution reopens that incident
// instead, without investigating again; but with that incident's mitigation
// still holding its cause off, the breach is most likely a new cause, and
// opens a new incident linked to it (relatedTo).
async function open(rule: WatchRule, trip: Trip, summary: string | undefined, nowMs: number): Promise<Incident | undefined> {
  const now = new Date(nowMs).toISOString();
  // The bundled examples are never the live outage, though one carries a
  // rule. Only the rule's incidents: the others can't be reopened by it.
  const runs = (await listIncidents({ ruleId: rule.id })).filter((i) => !isExample(i.id));
  const previous = incidentToReopen(runs, { ruleId: rule.id, route: trip.route }, nowMs);
  const held = previous && (await heldOff(previous));
  const relatedTo = previous && held ? related(previous, held, nowMs) : undefined;
  if (relatedTo) console.log(`[triage] watch rule ${rule.id} on ${trip.route} again; ${relatedTo.id}'s mitigation holds, so a new incident`);
  if (previous && !relatedTo) {
    // Already reopened (its verification saw the breach first): the episode
    // joins it as it is.
    const incident = await patchIncident(previous.id, (i) =>
      isOpen(i) ? i : reopened(i, { at: now, by: "watch", why: `${summary ?? rule.name} again` }),
    );
    state.lastOpened = { incidentId: incident.id, at: now, rule: rule.name, title: incident.title, reopened: true };
    recordOpened(state.lastOpened);
    deps.notify("incident_reopened", incident);
    console.log(`[triage] watch rule ${rule.id} reopened ${incident.id}`);
    return incident;
  }
  const problem = await deps.investigationProblem();
  if (problem) {
    state.error = `${problem} No incident was opened.`;
    state.errorKind = "open";
    return undefined;
  }
  const { incident, investigate } = await deps.createIncident(rule, trip, relatedTo);
  state.lastOpened = { incidentId: incident.id, at: new Date(deps.now()).toISOString(), rule: rule.name, title: incident.title };
  recordOpened(state.lastOpened);
  console.log(`[triage] watch rule ${rule.id} opened ${incident.id}: ${incident.title}`);
  // Slack hears within the check, before the investigation starts.
  deps.notify("incident_opened", incident);
  // The pipeline runs on its own; the watch keeps checking meanwhile.
  void investigate();
  return incident;
}

// Whether a resolved incident's mitigation holds its cause off, so a breach
// on its rule and route has a new cause rather than the old one back:
// "held" when the service says it's still in place; "unknown" when it was
// applied and the service can't say, presumed held (Triage never undoes one
// itself, and filing a new cause under an old diagnosis costs more than a
// second investigation). Not for an incident still open, recovering or
// verifying: the breach is that outage not over yet, and joins it.
async function heldOff(previous: Incident): Promise<"held" | "unknown" | undefined> {
  if (previous.status !== "resolved") return undefined;
  const inEffect = await deps.mitigationInEffect(previous);
  return inEffect === true ? "held" : inEffect === undefined ? "unknown" : undefined;
}

// The new incident's link to the one it would have reopened.
function related(previous: Incident, held: "held" | "unknown", now: number): NonNullable<Incident["relatedTo"]> {
  const m = previous.mitigation!;
  const what = m.kind === "flag_off" ? `${m.target} off` : `${m.target} rolled back`;
  const minutes = Math.max(1, Math.round((now - Date.parse(previous.resolvedAt ?? previous.detectedAt)) / MINUTE));
  const standing =
    held === "held"
      ? `with its mitigation (${what}) still in effect`
      : `after its mitigation (${what}), which Triage couldn't confirm is still in effect`;
  return {
    id: previous.id,
    title: previous.title,
    why: `Same rule and route, resolved ${minutes} min before this opened, ${standing}, so this breach was investigated as a new cause.`,
  };
}

// For tests: the watch as a new process starts it (nothing in memory, so
// episodes are rebuilt from the saved incidents), on, with `replace` swapped
// in, and checking only when told to.
export const watchForTests = {
  restart(replace: Partial<Deps> = {}) {
    if (state.timer) clearInterval(state.timer);
    state = g.triageWatch = { ...fresh(), enabled: true, status: "idle" };
    deps = { ...realDeps, ...replace };
  },
  check: () => check(),
  episodes: () => new Map([...state.episodes].map(([id, e]) => [id, { ...e }])),
};
