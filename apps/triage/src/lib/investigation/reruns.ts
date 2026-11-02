import { effortLabels } from "../models/stages";
import { type Incident, type Rerun, type RunModels, runFields, type StageChoice } from "./schema";
import { sourceKind } from "./source-kind";

// An incident's runs: the first investigation, and re-runs of it on the
// same telemetry with other models. The incident's own fields hold one of
// them (runNumber, the first unless a re-run was promoted); the others sit
// in `reruns`. A re-run never acts: its mitigation and fix are shown, not
// carried out, and it sends nothing, until it is promoted to be the
// incident's run. Safe to import in the browser.

// How long the collector's files keep live telemetry (otlp-files.ts's
// RETENTION_MS), and how far before the alert a run reads: the alert chart's
// window, where an investigation starts.
export const LIVE_RETENTION_MS = 3 * 60 * 60_000;
export const LOOKBACK_MS = 30 * 60_000;

export const currentRun = (incident: Pick<Incident, "runNumber">) => incident.runNumber ?? 1;

// The incident's own run, as a re-run record.
export function ownRun(incident: Incident): Rerun {
  const run = Object.fromEntries(runFields.map((f) => [f, incident[f]])) as Omit<Rerun, "number">;
  return { ...run, number: currentRun(incident) };
}

// Every run, the incident's own included, in the order started.
export function allRuns(incident: Incident): Rerun[] {
  return [ownRun(incident), ...(incident.reruns ?? [])].sort((a, b) => a.number - b.number);
}

export function findRun(incident: Incident, number: number): Rerun | undefined {
  return allRuns(incident).find((r) => r.number === number);
}

// The incident as run `number` saw it, for the page to show that run: its
// own investigation and outcome, and none of what belongs to the incident's
// run (questions, verification, resolution). Undefined for a run it hasn't.
export function runView(incident: Incident, number: number): Incident | undefined {
  if (number === currentRun(incident)) return incident;
  const run = incident.reruns?.find((r) => r.number === number);
  if (!run) return undefined;
  const fields = Object.fromEntries(runFields.map((f) => [f, run[f]]));
  return {
    ...incident,
    ...fields,
    questions: undefined,
    verification: undefined,
    resolvedAt: undefined,
    reopenings: undefined,
  } as Incident;
}

const running = (r: Pick<Rerun, "status" | "fixRun">) =>
  r.status === "investigating" || r.fixRun?.status === "writing" || r.fixRun?.status === "testing";

export const isRunning = running;

// Why the incident can't be investigated again, or undefined when it can,
// as far as its record tells: the server also checks the data is still
// there (rerun.ts). `now` is the wall clock.
export function rerunBlocker(incident: Incident, now: number): string | undefined {
  if (!incident.run) return "Bundled examples have no telemetry behind them to investigate again.";
  if (incident.status === "investigating") return "Wait for the investigation to finish, then re-run it.";
  const kind = sourceKind(incident);
  if (!kind) return "Triage can't read this incident's telemetry again.";
  if (kind === "live" || (kind === "uptime" && incident.snapshot)) {
    if (!incident.snapshot) {
      return "This live incident is from before Triage saved the database checks and code an investigation reads, so a re-run would see them as they are now, not as they were.";
    }
    if (now - earliestRead(incident) > LIVE_RETENTION_MS) {
      return "Its telemetry has rolled out of the collector's files, which keep the last 3 hours.";
    }
  }
  return undefined;
}

// The earliest moment a run of the incident reads: before the alert by
// the chart's window, or the start of a range a person picked.
export function earliestRead(incident: Pick<Incident, "detectedAt" | "trigger">): number {
  const before = Date.parse(incident.detectedAt) - LOOKBACK_MS;
  const focus = incident.trigger.focus ? Date.parse(incident.trigger.focus.from) : Infinity;
  return Math.min(before, focus);
}

// Whether the incident has acted on its run's diagnosis: a mitigation or
// fix approved, a verification started, or resolved. Its run then stays.
function acted(incident: Incident): string | undefined {
  const m = incident.mitigation?.state;
  if (m === "approved" || m === "running" || m === "applied") return "its mitigation was approved";
  if (incident.approval?.state === "approved") return "its fix was approved";
  if (incident.verification) return "its fix is being verified";
  if (incident.status === "resolved") return "the incident was resolved";
  return undefined;
}

// Why run `number` can't become the incident's run, or undefined when it can.
export function promoteBlocker(incident: Incident, number: number): string | undefined {
  const run = incident.reruns?.find((r) => r.number === number);
  if (!run) return number === currentRun(incident) ? "It's already the incident's run." : `There's no run ${number}.`;
  if (running(run)) return "It's still running. Use it once it finishes.";
  if (run.status === "failed" || !run.report) return "It has no diagnosis to use.";
  const why = acted(incident);
  if (why) return `The incident already acted on run ${currentRun(incident)}'s diagnosis: ${why}.`;
  if (running(incident)) return `Run ${currentRun(incident)} is still working. Wait for it to finish.`;
  if (incident.postmortem?.status === "writing") return "A postmortem is being written. Wait for it to finish.";
  return undefined;
}

// The incident with run `number` as its run, and the run it had among its
// re-runs. Questions stay: they're the incident's, asked of the run it had.
export function promote(incident: Incident, number: number): Incident {
  const run = incident.reruns?.find((r) => r.number === number);
  if (!run) throw new Error(`no run ${number}`);
  const fields = Object.fromEntries(runFields.map((f) => [f, run[f]]));
  return {
    ...incident,
    ...fields,
    runNumber: number,
    reruns: [...incident.reruns!.filter((r) => r.number !== number), ownRun(incident)].sort((a, b) => a.number - b.number),
  } as Incident;
}

// The models a run used, as a re-run would ask for them: the ones it was
// started with, else what its records say. A stage it never ran (no fix on a
// recorded scenario, no postmortem yet) is left out.
export function runModelsOf(run: Pick<Rerun, "models" | "run" | "fixRun" | "postmortem">): Partial<RunModels> {
  if (run.models) return run.models;
  const choice = (provider: string | undefined, model: string | undefined, effort?: StageChoice["effort"]) =>
    provider && model ? { provider, model, ...(effort && { effort }) } : undefined;
  const r = run.run;
  const fanout = r?.fanout;
  const models: Partial<RunModels> = {
    investigate: choice(r?.provider, r?.model, r?.reasoningEffort),
    lead: fanout && choice(fanout.leadProvider, fanout.leadModel, fanout.leadReasoningEffort),
    fix: choice(run.fixRun?.provider, run.fixRun?.model, run.fixRun?.reasoningEffort),
    postmortem: choice(run.postmortem?.provider, run.postmortem?.model, run.postmortem?.reasoningEffort),
  };
  return Object.fromEntries(Object.entries(models).filter(([, v]) => v)) as Partial<RunModels>;
}

// Whether a run of the incident goes on to write and prove a fix: one that
// reads the live Shopfront's code (a live run, or an uptime check of it).
export function runsFix(incident: Pick<Incident, "run" | "snapshot">): boolean {
  const kind = sourceKind(incident as Incident);
  return kind === "live" || (kind === "uptime" && incident.snapshot !== undefined);
}

// A run's models in a few words: "muse-glimmer-30b · high", or with its
// fan-out's lead, "muse-spark-1.3 + muse-wonder-1.0 lead · high".
export function runModelsLabel(r: Pick<Rerun, "run">): string {
  const run = r.run;
  if (!run) return "No run";
  const effort = run.reasoningEffort ? ` · ${effortLabels[run.reasoningEffort].toLowerCase()}` : "";
  return `${run.model}${run.fanout ? ` + ${run.fanout.leadModel} lead` : ""}${effort}`;
}

// The incident's runs other than its own, for the incident list.
export const otherRuns = (incident: Incident): Rerun[] => allRuns(incident).filter((r) => r.number !== currentRun(incident));
