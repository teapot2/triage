import { type LanguageModel, type ModelMessage, ToolLoopAgent, type ToolSet } from "ai";
import { cacheKey, callSettings, modelErrorText, modelOptions, reasoningKind } from "../../models/client";
import { RunTimeoutError } from "../../models/policy";
import type { Endpoint, StageModel } from "../../models/settings";
import { recordedEffort } from "../../models/stages";
import { addUsage, fuller, onEachCall, type TokenCounts } from "../../models/usage";
import { recordRunContext, recordThoughts } from "../agent";
import type { InvestigationRecorder, ThoughtRecorder } from "../recorder";
import type { Evidence, Fanout, Incident } from "../schema";
import type { TelemetrySource } from "../source";
import { createInvestigationTools } from "../tools";
import { LaneRecorder } from "./lane-recorder";
import {
  fallbackPrompt,
  type Hypothesis,
  laneInstructions,
  lanePrompt,
  mergeInstructions,
  mergePrompt,
  scoutInstructions,
  scoutPrompt,
} from "./prompts";
import { type Finding, type Proposal, proposeHypothesesTool, submitFindingTool } from "./tools";

// A fan-out investigation, in three phases:
// 1. Scout (the lead model): surveys with the read-only tools and proposes
//    0 to 3 hypotheses.
// 2. Lanes (the stage's model), one per hypothesis, side by side: each
//    looks for evidence for and against its hypothesis and submits a finding.
// 3. Merge (the lead model): reads every lane's evidence and finding, may
//    query a little more, and submits the report through the usual checks.
// A scout that fails hands over to the single agent; a lane that fails is
// an unclear finding, and the merge goes on. A merge that fails or ends
// without an accepted report hands over to the single agent too, with every
// lane's finding, for what is left of the run's steps.

export type Stage = Required<StageModel> & Endpoint;

const SCOUT_STEPS = 8;
const LANE_STEPS = 8;
const MERGE_STEPS = 6;
// Steps left when only an agent's finishing tool stays available.
const FINISH_RESERVE = 2;
// Times an agent that stops in plain text is told to finish.
const MAX_NUDGES = 1;
// A lane's own limit inside the run's budget, so one slow lane leaves the
// merge time to write the report.
const LANE_MINUTES = 4;

const SCOUT_NUDGE = "You have not proposed hypotheses yet. Call propose_hypotheses now.";
const LANE_NUDGE = "You have not submitted a finding yet. Call submit_finding now.";
const MERGE_NUDGE =
  "You have not submitted an accepted report yet. Keep investigating if needed, then call submit_report.";

export interface FanoutRun {
  incident: Incident;
  source: TelemetrySource;
  recorder: InvestigationRecorder;
  // The run's budget, shared by every phase and lane.
  budget: AbortSignal;
  // The lanes' tokens, and the lead's (scout and merge), kept apart so each
  // is priced at its own model's rates.
  tokens: TokenCounts;
  leadTokens: TokenCounts;
  // Model steps across the run, the single agent's included.
  count: { steps: number };
  // The lanes' model (the Investigate stage) and the lead's.
  lane: Stage;
  lead: Stage;
  model: (s: Stage) => LanguageModel;
  // The single-agent loop, for when the scout or the merge fails.
  alone: (messages: ModelMessage[]) => Promise<void>;
}

export async function runFanout(run: FanoutRun): Promise<void> {
  const { incident, source, recorder } = run;
  setFanout(recorder, {
    leadProvider: run.lead.provider,
    leadModel: run.lead.model,
    leadReasoningEffort: recordedEffort(run.lead),
    hypotheses: [],
  });

  // 1. Scout. Its steps stay on the record whatever happens next.
  let proposal: Proposal[] | undefined;
  recorder.lane = "scout";
  try {
    const scout = boundedAgent(run, run.lead, recorder, {
      instructions: scoutInstructions(),
      tools: {
        ...createInvestigationTools(source, recorder, { submit: false }),
        propose_hypotheses: proposeHypothesesTool(
          () => recorder.evidence,
          (hs) => (proposal = hs),
        ),
      },
      maxSteps: SCOUT_STEPS,
      finish: "propose_hypotheses",
      onCall: (call) => recordLeadContext(recorder, call),
      done: () => proposal !== undefined,
    });
    const content = scoutPrompt(incident, source);
    await generateUntilDone(scout, [{ role: "user", content }], SCOUT_NUDGE, run.budget, run.leadTokens);
  } catch (err) {
    if (run.budget.aborted) throw err;
    console.error("[triage] fan-out scout failed, investigating alone", incident.id, err);
  } finally {
    recorder.lane = undefined;
  }
  if (!proposal) {
    await run.alone([{ role: "user", content: fallbackPrompt(incident, source, recorder.evidence) }]);
    return;
  }

  // 2. Lanes, one per hypothesis, from the scout's evidence.
  const hypotheses: Hypothesis[] = proposal.map((p, i) => ({ ...p, id: `h${i + 1}` }));
  setFanout(recorder, {
    ...recorder.incident.run!.fanout!,
    hypotheses: hypotheses.map((h) => ({ id: h.id, title: h.title, claim: h.claim, evidenceFor: [], evidenceAgainst: [] })),
  });
  const scoutEvidence = [...recorder.evidence];
  const lanes = await Promise.all(hypotheses.map((h) => runLane(run, h, scoutEvidence)));
  // The lanes' evidence is on the incident already; their services count
  // toward the report's check from here.
  for (const lane of lanes) for (const s of lane.queriedServices) recorder.queriedServices.add(s);

  // 3. Merge.
  recorder.lane = "merge";
  try {
    const merge = boundedAgent(run, run.lead, recorder, {
      instructions: mergeInstructions(),
      tools: createInvestigationTools(source, recorder),
      maxSteps: MERGE_STEPS,
      finish: "submit_report",
      onCall: (call) => recordLeadContext(recorder, call),
      done: () => recorder.report !== undefined,
    });
    const content = mergePrompt(incident, source, recorder.evidence, recorder.incident.run!.fanout!.hypotheses);
    await generateUntilDone(merge, [{ role: "user", content }], MERGE_NUDGE, run.budget, run.leadTokens);
  } catch (err) {
    if (run.budget.aborted) throw err;
    console.error("[triage] fan-out merge failed, finishing alone", incident.id, err);
  } finally {
    recorder.lane = undefined;
  }
  // The lanes' work isn't lost to a merge that couldn't finish: the single
  // agent writes the report from it.
  if (!recorder.report) {
    const hypotheses = recorder.incident.run!.fanout!.hypotheses;
    await run.alone([{ role: "user", content: fallbackPrompt(incident, source, recorder.evidence, hypotheses) }]);
  }
}

// One hypothesis's lane. Never throws: a lane that fails, runs out of time
// or ends without a finding is an unclear finding with the error.
async function runLane(run: FanoutRun, h: Hypothesis, scoutEvidence: Evidence[]): Promise<LaneRecorder> {
  const lane = new LaneRecorder(h.id, run.recorder);
  let finding: Finding | undefined;
  let error: string | undefined;
  const limit = new AbortController();
  const timer = setTimeout(
    () => limit.abort(new RunTimeoutError(`The check of ${h.id} ran past its ${LANE_MINUTES}-minute limit.`)),
    LANE_MINUTES * 60_000,
  );
  timer.unref?.();
  const agent = boundedAgent(run, run.lane, lane, {
    instructions: laneInstructions(),
    tools: {
      ...createInvestigationTools(run.source, lane, { submit: false }),
      submit_finding: submitFindingTool(
        () => [...scoutEvidence, ...lane.evidence],
        (f) => (finding = f),
      ),
    },
    maxSteps: LANE_STEPS,
    finish: "submit_finding",
    done: () => finding !== undefined,
    // Each lane is a context of its own, and counts toward the run's too.
    onCall: (call) => {
      const fanout = run.recorder.incident.run!.fanout!;
      setFanout(run.recorder, {
        ...fanout,
        hypotheses: fanout.hypotheses.map((x) => (x.id === h.id ? { ...x, context: fuller(x.context, call) } : x)),
      });
      recordRunContext(run.recorder, call);
    },
  });
  try {
    const content = lanePrompt(run.incident, run.source, scoutEvidence, h);
    const signal = AbortSignal.any([run.budget, limit.signal]);
    await generateUntilDone(agent, [{ role: "user", content }], LANE_NUDGE, signal, run.tokens);
    if (!finding) error = `No finding after ${agent.steps()} model steps`;
  } catch (err) {
    console.error("[triage] fan-out lane failed", run.incident.id, h.id, err);
    error = modelErrorText(err, run.lane.provider);
  } finally {
    clearTimeout(timer);
  }
  const result = error
    ? { finding: "unclear" as const, reason: finding?.reason, evidenceFor: [], evidenceAgainst: [], error }
    : { ...finding! };
  const fanout = run.recorder.incident.run!.fanout!;
  setFanout(run.recorder, {
    ...fanout,
    hypotheses: fanout.hypotheses.map((x) => (x.id === h.id ? { ...x, ...result, steps: agent.steps() } : x)),
  });
  return lane;
}

type Bounded = {
  agent: ToolLoopAgent<never, ToolSet>;
  steps: () => number;
  maxSteps: number;
  done: () => boolean;
};

// A ToolLoopAgent capped at `maxSteps`, on the given model, recording its
// thoughts on `thoughts`. As in the single agent: near the cap only the
// finishing tool stays available, and it stops once `done`.
function boundedAgent<T extends ToolSet>(
  run: FanoutRun,
  s: Stage,
  thoughts: ThoughtRecorder,
  o: {
    instructions: string;
    tools: T;
    maxSteps: number;
    finish: keyof T & string;
    done: () => boolean;
    onCall: (call: TokenCounts) => void;
  },
): Bounded {
  let steps = 0;
  const agent = new ToolLoopAgent({
    model: run.model(s),
    providerOptions: modelOptions(s, cacheKey("investigate", run.incident.id)),
    ...callSettings(),
    ...recordThoughts(thoughts, reasoningKind(s.provider)),
    ...onEachCall(o.onCall),
    instructions: o.instructions,
    tools: o.tools as ToolSet,
    stopWhen: [() => steps >= o.maxSteps, o.done],
    prepareStep: () => {
      steps += 1;
      run.count.steps += 1;
      return steps > o.maxSteps - FINISH_RESERVE && !o.done() ? { activeTools: [o.finish] } : {};
    },
  });
  return { agent: agent as Bounded["agent"], steps: () => steps, maxSteps: o.maxSteps, done: o.done };
}

// Runs an agent until it finishes, nudging it once if it stops in plain
// text, and adds its tokens to `tokens`: the lead's or the lanes'.
async function generateUntilDone(
  { agent, steps, maxSteps, done }: Bounded,
  messages: ModelMessage[],
  nudge: string,
  abortSignal: AbortSignal,
  tokens: TokenCounts,
): Promise<void> {
  for (let attempt = 0; attempt <= MAX_NUDGES && !done() && steps() < maxSteps; attempt++) {
    if (attempt > 0) messages.push({ role: "user", content: nudge });
    const result = await agent.generate({ messages, abortSignal });
    messages.push(...result.responseMessages);
    addUsage(tokens, result.usage);
  }
}

// A call of the lead's, scout or merge, as its context if it's the fullest yet.
function recordLeadContext(recorder: InvestigationRecorder, call: TokenCounts) {
  const fanout = recorder.incident.run!.fanout!;
  setFanout(recorder, { ...fanout, context: fuller(fanout.context, call) });
}

function setFanout(recorder: InvestigationRecorder, fanout: Fanout) {
  recorder.update({ run: { ...recorder.incident.run!, fanout } });
}
