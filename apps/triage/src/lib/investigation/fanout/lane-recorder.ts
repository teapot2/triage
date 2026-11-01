import {
  assignId,
  completedStep,
  type EvidenceDraft,
  failedStep,
  type InvestigationRecorder,
  runningStep,
  type StepRecorder,
  type ThoughtRecorder,
} from "../recorder";
import type { Evidence, EvidenceKind, Thought, ToolName } from "../schema";

// Evidence IDs from a lane carry its hypothesis's ID, so h1's first log is
// ev_h1_log_1 and never collides with the scout's ev_log_1.
export const laneEvidencePrefix = (lane: string) => `ev_${lane}_`;

// Records one hypothesis's lane: its own evidence IDs and queried services,
// and its own current model call, since lanes run side by side. Steps,
// thoughts and evidence go straight onto the incident, tagged with the
// lane, so the timeline shows every lane as it runs.
export class LaneRecorder implements StepRecorder, ThoughtRecorder {
  readonly queriedServices = new Set<string>();
  readonly evidence: Evidence[] = [];
  private counters = new Map<EvidenceKind, number>();
  private currentCall: string | undefined;

  constructor(
    readonly lane: string,
    private parent: InvestigationRecorder,
  ) {}

  get service(): string {
    return this.parent.service;
  }

  startStep(id: string, tool: ToolName, input: Record<string, unknown>) {
    this.parent.addStep(runningStep(id, tool, input, this.currentCall, this.lane));
  }

  completeStep(id: string, tool: ToolName, summary: string, drafts: EvidenceDraft[]): Evidence[] {
    const evidence = drafts.map((d) => assignId(this.counters, laneEvidencePrefix(this.lane), d, tool));
    this.evidence.push(...evidence);
    this.parent.addEvidence(evidence);
    this.parent.updateStep(id, (step) => completedStep(step, summary, evidence));
    return evidence;
  }

  failStep(id: string, error: string) {
    this.parent.updateStep(id, (step) => failedStep(step, error));
  }

  startThought(id: string) {
    this.currentCall = id;
    this.parent.addThought(id, this.lane);
  }

  endThought(id: string, out: Pick<Thought, "reasoning" | "reasoningKind" | "text">) {
    this.parent.endThought(id, out);
  }
}
