import { liveService } from "../live/types";
import { investigationProblem } from "../models/settings";
import { notify } from "../notifications/notify";
import { evaluateSloRule } from "../slo/judge";
import { liveCounts, rolledThrough, routesSince } from "../slo/rollups";
import { createRuleIncident, runInvestigation } from "./agent";
import { type DependencyState, dependencyState, startDependencies, stopDependencies } from "./dependencies";
import { createLiveSource, type RequestSample, recentRequests, sampleStatements, shopfrontDir } from "./live/live-source";
import { RETENTION_MS } from "./live/otlp-files";
import { incidentToReopen, isOpen } from "./reopen";
import { isExample, listIncidents, patchIncident } from "./store";
import { type EndpointState, startUptime, stopUptime, uptimeState } from "./uptime";
import { reopened } from "./verify";
import { CHECK_MS, evaluateRule, HEALTHY_TO_REARM, isWatched, type RuleResult } from "./watch-judge";
import { describeRule, readRules, type WatchRule } from "./watch-rules";
import { errorMessage } from "../errors";

// Stage 1: Triage watches the live store and opens an incident on its own.
// Every CHECK_MS it judges each watch rule (see watch-rules) on the real
// requests in the rule's window, route by route. A rule over its limit on a
// route for checksToOpen checks in a row opens one incident and starts the
// whole pipeline (investigate, fix, prove); a single slow blip doesn't.
// Then the watch stays quiet for the rest of that episode, whichever rules
// trip, and re-arms once nothing has been over a limit for a minute, so one
// outage is one incident. A breach within half an hour of an incident on
// the same rule and route being resolved reopens that incident instead of
// opening another (see reopen). How a rule is judged is in watch-judge, shared
// with the backtest; an SLO rule, on how fast its error budget burns, in
// slo/judge, from the request counts slo/rollups keeps.

// The window the sidebar's request count covers.
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export type RuleStatus = "ok" | "breaching" | "alerting" | "idle" | "paused";

export type RuleState = {
  id: string;
  name: string;
  // The rule in a line: "p95 over 500 ms on each API route".
  description: string;
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
};

export type WatchState = {
  enabled: boolean;
  // ok: every rule within its limits. breaching: a rule over its limit, not
  // yet sustained. alerting: an incident is open for this episode. idle: too
  // little traffic to judge any rule.
  status: "ok" | "breaching" | "alerting" | "idle" | "paused";
  rules: RuleState[];
  // Requests the rules saw in the last minute, every watched route together.
  lastCheck?: { at: string; requests: number };
  // reopened: the watch reopened a recently resolved incident rather than
  // opening one.
  lastOpened?: { incidentId: string; at: string; rule: string; title?: string; reopened?: boolean };
  error?: string;
  // The uptime checks (see uptime), which start and pause with the watch.
  endpoints: EndpointState[];
  // The dependency audit (see dependencies), which does too.
  dependencies: DependencyState;
};

type Internal = Omit<WatchState, "rules" | "endpoints" | "dependencies"> & {
  version: number;
  timer?: ReturnType<typeof setInterval>;
  checking: boolean;
  healthy: number;
  // Checks in a row over the limit, per rule and route ("api-latency|/api/x").
  streaks: Map<string, number>;
  // Rules that tripped during the open episode.
  tripped: Set<string>;
  rules: RuleState[];
  // The routes the SLO rules judge, beyond those in the telemetry: every
  // route counted over the longest SLO window, read at most once a minute.
  sloRoutes?: { at: number; since: number; routes: { route: string; method: string }[] };
};

// On globalThis: one watcher per server process, across dev hot reloads.
// The timer calls whichever check() was loaded last, so an edit to this
// file takes effect without a restart. A state from an older shape of this
// module is replaced, keeping whether the watch was on.
const VERSION = 2;
const g = globalThis as unknown as { triageWatch?: Internal; triageWatchCheck?: () => Promise<void> };
const fresh = (): Internal => ({
  version: VERSION,
  enabled: false,
  status: "paused",
  checking: false,
  healthy: 0,
  streaks: new Map(),
  tripped: new Set(),
  rules: [],
});
const state = (() => {
  const old = g.triageWatch;
  if (old?.version === VERSION) return old;
  if (old?.timer) clearInterval(old.timer);
  g.triageWatch = fresh();
  if (old?.enabled) setTimeout(() => startWatch(), 0);
  return g.triageWatch;
})();
g.triageWatchCheck = check;

export function watchState(): WatchState {
  const { enabled, status, lastCheck, lastOpened, error } = state;
  const rules = enabled ? state.rules : state.rules.map((r) => ({ ...r, status: "paused" as const, summary: undefined }));
  return { enabled, status, rules, lastCheck, lastOpened, error, endpoints: uptimeState(), dependencies: dependencyState() };
}

export function startWatch() {
  if (state.timer) return;
  Object.assign(state, { enabled: true, status: "idle", healthy: 0, error: undefined });
  state.streaks.clear();
  state.tripped.clear();
  state.timer = setInterval(() => void g.triageWatchCheck?.(), CHECK_MS);
  void check();
  startUptime();
  startDependencies();
}

export function stopWatch() {
  if (state.timer) clearInterval(state.timer);
  Object.assign(state, { timer: undefined, enabled: false, status: "paused", healthy: 0 });
  state.streaks.clear();
  state.tripped.clear();
  stopUptime();
  stopDependencies();
}

// Checks now rather than at the next tick: after the rules change.
export function recheckWatch() {
  void check();
}

const severityRank = { sev1: 0, sev2: 1, sev3: 2, sev4: 3 } as const;

async function check() {
  // A slow read (a big telemetry file after a restart) must not overlap
  // the next tick.
  if (state.checking || !state.enabled) return;
  state.checking = true;
  try {
    const rules = await readRules();
    const now = Date.now();
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
    state.lastCheck = { at: new Date(now).toISOString(), requests: samples.filter((s) => s.start > now - MINUTE).length };
    state.error = undefined;

    const sloRoutes = slos.length ? routesToJudge(samples, slos, now) : [];
    const counts = liveCounts(liveService, samples, through);
    const results = rules.map(
      (rule): { rule: WatchRule } & RuleResult => ({
        rule,
        ...(rule.condition.metric === "slo"
          ? evaluateSloRule(rule, sloRoutes, counts, now)
          : evaluateRule(rule, samples, now, state.streaks)),
      }),
    );
    const breaching = results.some((r) => r.status === "breaching");
    const anyOk = results.some((r) => r.status === "ok");
    // Several at once (latency and errors in the same outage): the most
    // severe opens the incident, ties going to the rule listed first. A slow
    // burn's trip carries its own, lower severity.
    const rank = (r: { rule: WatchRule } & RuleResult) => severityRank[r.trip?.severity ?? r.rule.severity];
    const trips = results.filter((r) => r.trip).sort((a, b) => rank(a) - rank(b));

    const first = trips[0];
    if (state.status === "alerting") {
      // The open episode takes in whatever else trips. It ends once nothing
      // has been over a limit for HEALTHY_TO_REARM judged checks.
      for (const r of trips) state.tripped.add(r.rule.id);
      state.healthy = breaching ? 0 : anyOk ? state.healthy + 1 : state.healthy;
      if (state.healthy >= HEALTHY_TO_REARM) {
        Object.assign(state, { status: "ok", healthy: 0 });
        state.tripped.clear();
        state.streaks.clear();
      }
    } else if (first?.trip) {
      // Alerting only once the incident is open. If it can't be, the rule
      // stays breaching, so the next check tries again and the error stays up.
      const opened = await open(first.rule, first.trip, first.summary).catch((err: unknown) => {
        state.error = `Couldn't open an incident: ${errorMessage(err)}`;
        return false;
      });
      // Paused while it opened: the pause stands.
      if (!state.enabled) return;
      if (opened) {
        for (const r of trips) state.tripped.add(r.rule.id);
        Object.assign(state, { status: "alerting", healthy: 0 });
      } else {
        state.status = "breaching";
      }
    } else {
      state.status = breaching ? "breaching" : anyOk ? "ok" : "idle";
    }

    state.rules = results.map(
      (r): RuleState => ({
        id: r.rule.id,
        name: r.rule.name,
        description: describeRule(r.rule),
        status: state.status === "alerting" && state.tripped.has(r.rule.id) ? "alerting" : r.status,
        summary: r.summary,
        checks: r.checks,
        needed: r.rule.condition.metric === "slo" ? 1 : r.rule.checksToOpen,
        budgetLeftPercent: r.budgetLeftPercent,
      }),
    );
  } catch (err) {
    state.error = errorMessage(err);
  } finally {
    state.checking = false;
  }
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

// Opens the incident and starts its run; false when no model can run it.
// The same outage back soon after a resolution reopens that incident
// instead, without investigating again.
async function open(rule: WatchRule, trip: NonNullable<RuleResult["trip"]>, summary?: string): Promise<boolean> {
  const now = new Date().toISOString();
  // The bundled examples are never the live outage, though one carries a
  // rule. Only the rule's incidents: the others can't be reopened by it.
  const runs = (await listIncidents({ ruleId: rule.id })).filter((i) => !isExample(i.id));
  const previous = incidentToReopen(runs, { ruleId: rule.id, route: trip.route }, Date.parse(now));
  if (previous) {
    // Already reopened (its verification saw the breach first): the episode
    // joins it as it is.
    const incident = await patchIncident(previous.id, (i) =>
      isOpen(i) ? i : reopened(i, { at: now, by: "watch", why: `${summary ?? rule.name} again` }),
    );
    state.lastOpened = { incidentId: incident.id, at: now, rule: rule.name, title: incident.title, reopened: true };
    notify("incident_reopened", incident);
    console.log(`[triage] watch rule ${rule.id} reopened ${incident.id}`);
    return true;
  }
  const problem = await investigationProblem();
  if (problem) {
    state.error = `${problem} No incident was opened.`;
    return false;
  }
  const source = await createLiveSource();
  const incident = await createRuleIncident(source, { rule, ...trip });
  state.lastOpened = { incidentId: incident.id, at: new Date().toISOString(), rule: rule.name, title: incident.title };
  console.log(`[triage] watch rule ${rule.id} opened ${incident.id}: ${incident.title}`);
  // Slack hears within the check, before the investigation starts.
  notify("incident_opened", incident);
  // The pipeline runs on its own; the watch keeps checking meanwhile.
  void runInvestigation(incident, source, { appDir: shopfrontDir });
  return true;
}
