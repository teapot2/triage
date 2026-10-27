import { stageModel, stageProblem } from "../models/settings";
import { createLiveIncident, ERROR_LIMIT, runInvestigation } from "./agent";
import { createLiveSource, liveAlert, routeHealth, shopfrontDir } from "./live/live-source";

// Stage 1: Triage watches the live store and opens an incident on its own.
// Every CHECK_MS it measures the alerted route over the last WINDOW_MS of
// real requests. Two breaching checks in a row open one incident and start
// the whole pipeline (investigate, fix, prove); a single slow blip doesn't.
// It stays quiet for the rest of that episode and re-arms once the route
// has been healthy for a minute, so one outage is one incident.

const CHECK_MS = 10_000;
const WINDOW_MS = 60_000;
// Too few requests to judge: idle, or traffic just started.
const MIN_REQUESTS = 5;
const BREACHES_TO_OPEN = 2;
const HEALTHY_TO_REARM = 6;

export type WatchState = {
  enabled: boolean;
  // ok: within limits. breaching: over a limit, not yet sustained. alerting:
  // sustained, incident opened. idle: too little traffic to judge.
  status: "ok" | "breaching" | "alerting" | "idle" | "paused";
  lastCheck?: { at: string; requests: number; p95Ms: number | null; errorRatio: number | null };
  lastOpened?: { incidentId: string; at: string };
  error?: string;
};

type Internal = WatchState & { timer?: ReturnType<typeof setInterval>; breaches: number; healthy: number; checking: boolean };

// On globalThis: one watcher per server process, across dev hot reloads.
const g = globalThis as unknown as { triageWatch?: Internal };
const state = (g.triageWatch ??= { enabled: false, status: "paused", breaches: 0, healthy: 0, checking: false });

export function watchState(): WatchState {
  const { enabled, status, lastCheck, lastOpened, error } = state;
  return { enabled, status, lastCheck, lastOpened, error };
}

export function startWatch() {
  if (state.timer) return;
  Object.assign(state, { enabled: true, status: "idle", breaches: 0, healthy: 0, error: undefined });
  state.timer = setInterval(() => void check(), CHECK_MS);
  void check();
}

export function stopWatch() {
  if (state.timer) clearInterval(state.timer);
  Object.assign(state, { timer: undefined, enabled: false, status: "paused", breaches: 0, healthy: 0 });
}

async function check() {
  // A slow read (a big telemetry file after a restart) must not overlap
  // the next tick.
  if (state.checking || !state.enabled) return;
  state.checking = true;
  try {
    const h = await routeHealth(WINDOW_MS);
    state.lastCheck = { at: new Date().toISOString(), ...h };
    state.error = undefined;
    if (h.requests < MIN_REQUESTS) {
      // No verdict without traffic; an open episode stays open.
      if (state.status !== "alerting") state.status = "idle";
      return;
    }
    const breaching = (h.p95Ms ?? 0) > liveAlert.threshold || (h.errorRatio ?? 0) > ERROR_LIMIT;

    if (state.status === "alerting") {
      state.healthy = breaching ? 0 : state.healthy + 1;
      if (state.healthy >= HEALTHY_TO_REARM) Object.assign(state, { status: "ok", breaches: 0, healthy: 0 });
      return;
    }
    if (!breaching) {
      Object.assign(state, { status: "ok", breaches: 0 });
      return;
    }
    state.breaches += 1;
    state.status = "breaching";
    if (state.breaches >= BREACHES_TO_OPEN) await open(h.errorRatio ?? 0);
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  } finally {
    state.checking = false;
  }
}

async function open(errorRatio: number) {
  Object.assign(state, { status: "alerting", healthy: 0 });
  const problem = stageProblem(await stageModel("investigate"));
  if (problem) {
    state.error = `${problem} No incident was opened.`;
    return;
  }
  const source = await createLiveSource();
  const incident = await createLiveIncident(source, { openedBy: "watch", errorRatio });
  state.lastOpened = { incidentId: incident.id, at: new Date().toISOString() };
  console.log(`[triage] watch opened ${incident.id}: ${incident.title}`);
  // The pipeline runs on its own; the watch keeps checking meanwhile.
  void runInvestigation(incident, source, { appDir: shopfrontDir });
}
