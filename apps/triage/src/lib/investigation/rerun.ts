import { choiceModel, stageProblem } from "../models/settings";
import { recordedEffort, type StageId } from "../models/stages";
import { runInvestigation } from "./agent";
import type { Stage } from "./fanout/run";
import { shopfrontDir } from "./live/live-source";
import { readTelemetry } from "./live/otlp-files";
import { hasSnapshotFiles, snapshotSourceDir, withSnapshot } from "./live/run-snapshot";
import { earliestRead, promote, promoteBlocker, rerunBlocker, runsFix } from "./reruns";
import { type Incident, type Rerun, type RunModels, runFields, type StageChoice } from "./schema";
import type { TelemetrySource } from "./source";
import { sourceFor } from "./source-for";
import { sourceKind } from "./source-kind";
import { getIncident, patchIncident } from "./store";
import { readSamples } from "./uptime/samples";
import { errorMessage } from "../errors";

// Re-runs: the incident's investigation again, on the telemetry its first
// run read, with the models a person picked for each stage. Each is kept on
// the incident beside its run (reruns.ts says how they're shown and
// promoted). A re-run goes as far as its first run would have (a live one
// writes and proves a fix in the sandbox) but acts on nothing and notifies
// no one: the watch, the verification and the notifications only ever see
// the incident's own run.

export class RerunRefused extends Error {}

// The incident's telemetry as its first run read it: the source it
// recorded, anchored at the alert, with a live run's database, source and
// git reads answered from its snapshot.
async function rerunSource(incident: Incident): Promise<TelemetrySource | undefined> {
  const source = await sourceFor(incident);
  if (!source || !incident.snapshot) return source;
  return withSnapshot(source, incident.id, incident.snapshot);
}

// Why the incident can't be re-run now, or undefined: what the record says
// (reruns.ts), then whether what a run reads is still there.
export async function rerunProblem(incident: Incident): Promise<string | undefined> {
  const blocked = rerunBlocker(incident, Date.now());
  if (blocked) return blocked;
  if (incident.snapshot && !(await hasSnapshotFiles(incident.id))) {
    return "The snapshot of the database checks and code this incident's run read is gone from .data/snapshots.";
  }
  const kind = sourceKind(incident);
  if (kind === "live" || (kind === "uptime" && incident.snapshot)) {
    const { spans, logs, metrics } = await readTelemetry();
    let oldest = Infinity;
    for (const s of spans) oldest = Math.min(oldest, s.start);
    for (const r of [...logs, ...metrics]) oldest = Math.min(oldest, r.time);
    // A minute's slack: the collector writes in batches.
    if (oldest > earliestRead(incident) + 60_000) {
      return "Its telemetry is no longer in the collector's files (after a restart they may hold only the last part).";
    }
  }
  if (kind === "uptime") {
    const id = incident.run!.source.slice("uptime:".length);
    const samples = await readSamples(id).catch(() => []);
    if (!samples.some((s) => Date.parse(s.at) <= Date.parse(incident.detectedAt))) {
      return "The uptime check's results from the time of the alert are gone: it keeps only its latest ones.";
    }
  }
  return undefined;
}

type ResolvedModels = { investigate: Stage; lead?: Stage; fix?: Stage; postmortem?: Stage };

// Each chosen model with its endpoint, refused if one can't run.
async function resolveModels(models: RunModels): Promise<ResolvedModels> {
  const resolved: Partial<ResolvedModels> = {};
  for (const stage of ["investigate", "lead", "fix", "postmortem"] as const) {
    const choice: StageChoice | undefined = models[stage];
    if (!choice) continue;
    const model = await choiceModel(stage satisfies StageId, choice);
    if (!model) throw new RerunRefused(`Unknown provider for ${stage}: ${choice.provider}`);
    const problem = stageProblem(model);
    if (problem) throw new RerunRefused(problem);
    resolved[stage] = model;
  }
  return resolved as ResolvedModels;
}

// Adds a re-run to the incident and returns its number; the caller runs it
// (runRerun) after answering. Throws RerunRefused when it can't start.
export async function startRerun(id: string, models: RunModels): Promise<number> {
  const incident = await getIncident(id);
  if (!incident) throw new RerunRefused(`unknown incident: ${id}`);
  const problem = await rerunProblem(incident);
  if (problem) throw new RerunRefused(problem);
  const stages = await resolveModels(models);
  let number = 0;
  // Numbered under the incident's lock, so two quick re-runs get two numbers.
  await patchIncident(id, (i) => {
    const blocked = rerunBlocker(i, Date.now());
    if (blocked) throw new RerunRefused(blocked);
    number = Math.max(i.runNumber ?? 1, ...(i.reruns ?? []).map((r) => r.number)) + 1;
    const rerun: Rerun = {
      number,
      status: "investigating",
      steps: [],
      thoughts: [],
      evidence: [],
      run: {
        source: i.run!.source,
        provider: stages.investigate.provider,
        model: stages.investigate.model,
        reasoningEffort: recordedEffort(stages.investigate),
        startedAt: new Date().toISOString(),
      },
      models,
    };
    return { ...i, reruns: [...(i.reruns ?? []), rerun] };
  });
  return number;
}

// The re-run's fields from the investigation's working record.
const runOf = (number: number, work: Incident): Rerun =>
  ({ number, ...Object.fromEntries(runFields.map((f) => [f, work[f]])) }) as Rerun;

const saveRun = (id: string, number: number) => (work: Incident) =>
  patchIncident(id, (i) => ({
    ...i,
    reruns: (i.reruns ?? []).map((r) => (r.number === number ? runOf(number, work) : r)),
  })).then(() => undefined);

// Runs re-run `number` of the incident, saving it on the incident as it
// goes. Never throws: a failure is recorded on the re-run.
export async function runRerun(id: string, number: number): Promise<void> {
  const save = saveRun(id, number);
  const incident = await getIncident(id);
  const rerun = incident?.reruns?.find((r) => r.number === number);
  if (!incident || !rerun) return;
  // A working record of its own, under an ID of its own (the sandbox and
  // the prompt cache are keyed by it), saved into the incident's re-run.
  const work: Incident = {
    id: `${id}_r${number}`,
    title: incident.title,
    service: incident.service,
    severity: incident.severity,
    status: "investigating",
    detectedAt: incident.detectedAt,
    openedBy: incident.openedBy,
    trigger: incident.trigger,
    uptime: incident.uptime,
    steps: [],
    thoughts: [],
    evidence: [],
    run: rerun.run,
    models: rerun.models,
  };
  const fail = (error: string) =>
    save({ ...work, status: "failed", run: { ...work.run!, finishedAt: new Date().toISOString(), error } }).catch((err) =>
      console.error("[triage] couldn't record the re-run's failure", id, number, err),
    );
  try {
    const source = await rerunSource(incident);
    if (!source) return void (await fail("Triage can't read this incident's telemetry again."));
    const stages = await resolveModels(rerun.models!);
    await runInvestigation(work, source, {
      stage: stages.investigate,
      fanout: stages.lead ? { lead: stages.lead } : false,
      save,
      appDir: runsFix(incident) ? shopfrontDir : undefined,
      rerun: { fix: stages.fix, baseDir: incident.snapshot ? snapshotSourceDir(incident.id) : undefined },
    });
  } catch (err) {
    console.error("[triage] re-run failed", id, number, err);
    await fail(errorMessage(err));
  }
}

// Makes run `number` the incident's run. Throws RerunRefused when it can't.
export async function promoteRun(id: string, number: number): Promise<Incident> {
  return patchIncident(id, (i) => {
    const blocked = promoteBlocker(i, number);
    if (blocked) throw new RerunRefused(blocked);
    return promote(i, number);
  });
}
