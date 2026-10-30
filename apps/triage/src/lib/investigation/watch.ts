import { stageModel, stageProblem } from "../models/settings";
import { createRuleIncident, runInvestigation } from "./agent";
import { createLiveSource, recentRequests, shopfrontDir } from "./live/live-source";
import { CHECK_MS, evaluateRule, HEALTHY_TO_REARM, isWatched } from "./watch-judge";
import { describeRule, readRules, type WatchRule } from "./watch-rules";

// Stage 1: Triage watches the live store and opens an incident on its own.
// Every CHECK_MS it judges each watch rule (see watch-rules) on the real
// requests in the rule's window, route by route. A rule over its limit on a
// route for checksToOpen checks in a row opens one incident and starts the
// whole pipeline (investigate, fix, prove); a single slow blip doesn't.
// Then the watch stays quiet for the rest of that episode, whichever rules
// trip, and re-arms once nothing has been over a limit for a minute, so one
// outage is one incident. How a rule is judged is in watch-judge, shared
// with the backtest.

// The window the sidebar's request count covers.
const MINUTE = 60_000;

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
  lastOpened?: { incidentId: string; at: string; rule: string };
  error?: string;
};

type Internal = Omit<WatchState, "rules"> & {
  version: number;
  timer?: ReturnType<typeof setInterval>;
  checking: boolean;
  healthy: number;
  // Checks in a row over the limit, per rule and route ("api-latency|/api/x").
  streaks: Map<string, number>;
  // Rules that tripped during the open episode.
  tripped: Set<string>;
  rules: RuleState[];
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
  return { enabled, status, rules, lastCheck, lastOpened, error };
}

export function startWatch() {
  if (state.timer) return;
  Object.assign(state, { enabled: true, status: "idle", healthy: 0, error: undefined });
  state.streaks.clear();
  state.tripped.clear();
  state.timer = setInterval(() => void g.triageWatchCheck?.(), CHECK_MS);
  void check();
}

export function stopWatch() {
  if (state.timer) clearInterval(state.timer);
  Object.assign(state, { timer: undefined, enabled: false, status: "paused", healthy: 0 });
  state.streaks.clear();
  state.tripped.clear();
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
    const longest = Math.max(MINUTE, ...rules.map((r) => r.windowSeconds * 1000));
    const samples = (await recentRequests(longest)).filter(isWatched);
    state.lastCheck = { at: new Date(now).toISOString(), requests: samples.filter((s) => s.start > now - MINUTE).length };
    state.error = undefined;

    const results = rules.map((rule) => ({ rule, ...evaluateRule(rule, samples, now, state.streaks) }));
    const breaching = results.some((r) => r.status === "breaching");
    const anyOk = results.some((r) => r.status === "ok");
    // Several at once (latency and errors in the same outage): the most
    // severe opens the incident, ties going to the rule listed first.
    const trips = results.filter((r) => r.trip).sort((a, b) => severityRank[a.rule.severity] - severityRank[b.rule.severity]);

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
      const opened = await open(first.rule, first.trip).catch((err: unknown) => {
        state.error = `Couldn't open an incident: ${err instanceof Error ? err.message : String(err)}`;
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
        needed: r.rule.checksToOpen,
      }),
    );
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  } finally {
    state.checking = false;
  }
}

// Opens the incident and starts its run; false when no model can run it.
async function open(rule: WatchRule, trip: { route: string; method: string }): Promise<boolean> {
  const problem = stageProblem(await stageModel("investigate"));
  if (problem) {
    state.error = `${problem} No incident was opened.`;
    return false;
  }
  const source = await createLiveSource();
  const incident = await createRuleIncident(source, { rule, ...trip });
  state.lastOpened = { incidentId: incident.id, at: new Date().toISOString(), rule: rule.name };
  console.log(`[triage] watch rule ${rule.id} opened ${incident.id}: ${incident.title}`);
  // The pipeline runs on its own; the watch keeps checking meanwhile.
  void runInvestigation(incident, source, { appDir: shopfrontDir });
  return true;
}
