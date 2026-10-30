import type { Evidence, EvidenceKind, Incident, InvestigationReport, Question, Thought, ToolName } from "./schema";
import { getIncident, patchIncident, withIncidentLock } from "./store";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// Evidence as a tool produces it; the recorder assigns the ID.
export type EvidenceDraft = DistributiveOmit<Evidence, "id" | "tool">;

// What the tools need from a recorder: each call recorded as a step, its
// evidence given IDs, and the services it touched.
export interface StepRecorder {
  readonly queriedServices: Set<string>;
  // The incident's service, credited for source and git reads.
  readonly service: string;
  startStep(id: string, tool: ToolName, input: Record<string, unknown>): void;
  completeStep(id: string, tool: ToolName, summary: string, drafts: EvidenceDraft[]): Evidence[];
  failStep(id: string, error: string): void;
}

// What recordThoughts needs: a thought opened per model call, closed when
// the call ends.
export interface ThoughtRecorder {
  startThought(id: string): void;
  endThought(id: string, out: Pick<Thought, "reasoning" | "reasoningKind" | "text">): void;
}

type Step = Incident["steps"][number];

// Owns the incident while the agent runs: assigns evidence IDs, tracks
// steps and queried services, and saves after every change so the UI can
// follow along. Saves are serialized so a slow write never lands after a
// newer one.
export class InvestigationRecorder implements StepRecorder, ThoughtRecorder {
  readonly queriedServices = new Set<string>();
  rejectedReports = 0;
  private counters = new Map<EvidenceKind, number>();
  private writes: Promise<void> = Promise.resolve();

  constructor(
    public incident: Incident,
    private save: (incident: Incident) => Promise<void>,
  ) {}

  get report(): InvestigationReport | undefined {
    return this.incident.report;
  }

  get evidence(): Evidence[] {
    return this.incident.evidence;
  }

  get service(): string {
    return this.incident.service;
  }

  startStep(id: string, tool: ToolName, input: Record<string, unknown>) {
    this.incident.steps.push(runningStep(id, tool, input));
    this.persist();
  }

  completeStep(id: string, tool: ToolName, summary: string, drafts: EvidenceDraft[]): Evidence[] {
    const evidence = drafts.map((d) => assignId(this.counters, "ev_", d, tool));
    this.incident.evidence.push(...evidence);
    this.updateStep(id, (step) => completedStep(step, summary, evidence));
    return evidence;
  }

  // A model call began: shown as "Thinking…" until it ends.
  startThought(id: string) {
    this.incident.thoughts = startedThought(this.incident.thoughts, id);
    this.persist();
  }

  // A model call ended, before its tool calls run. A call that returned no
  // thinking and no text (Meta's Chat Completions keeps both private) is
  // dropped, so the timeline doesn't fill with empty rows.
  endThought(id: string, out: Pick<Thought, "reasoning" | "reasoningKind" | "text">) {
    this.incident.thoughts = endedThought(this.incident.thoughts, id, out);
    this.persist();
  }

  // A call that failed never ends; once the run is over, its "Thinking…"
  // would spin forever, so it goes.
  dropUnfinishedThoughts() {
    const thoughts = this.incident.thoughts ?? [];
    if (thoughts.every((t) => t.durationMs !== undefined)) return;
    this.incident.thoughts = finishedThoughts(thoughts);
    this.persist();
  }

  failStep(id: string, error: string) {
    this.updateStep(id, (step) => failedStep(step, error));
  }

  update(patch: Partial<Incident>) {
    this.incident = { ...this.incident, ...patch };
    this.persist();
  }

  flush(): Promise<void> {
    return this.writes;
  }

  private updateStep(id: string, fn: (step: Step) => Step) {
    this.incident.steps = this.incident.steps.map((s) => (s.id === id ? fn(s) : s));
    this.persist();
  }

  private persist() {
    const snapshot = structuredClone(this.incident);
    // Routes change the mitigation, the questions and the fix attempts, and
    // the verification resolves or reopens the incident, and the uptime loop
    // counts failing checks, while a stage still runs here; a whole-snapshot
    // save would overwrite them. A resolved incident stays resolved when the
    // fix stage finishes.
    this.writes = this.writes
      .then(() =>
        withIncidentLock(snapshot.id, async () => {
          const stored = await getIncident(snapshot.id);
          await this.save({
            ...snapshot,
            mitigation: stored?.mitigation ?? snapshot.mitigation,
            questions: stored?.questions ?? snapshot.questions,
            fixAttempts: stored?.fixAttempts ?? snapshot.fixAttempts,
            ...(stored && {
              status: stored.status === "resolved" ? "resolved" : snapshot.status,
              verification: stored.verification,
              resolvedAt: stored.resolvedAt,
              reopenings: stored.reopenings,
              uptime: stored.uptime,
            }),
          });
        }),
      )
      .catch((err) => console.error("[triage] failed to save incident", snapshot.id, err));
  }
}

// Evidence IDs on a question carry its ID, so q_2's first span is
// ev_q2_span_1 and never collides with the investigation's ev_span_1.
export const questionEvidencePrefix = (questionId: string) => `ev_${questionId.replace("_", "")}_`;

// How often a running question is saved: often enough that a reload or a
// second tab sees the answer grow, rarely enough not to rewrite the file
// on every token.
export const QUESTION_SAVE_MS = 300;

// Owns one question while it is answered: the same steps and thoughts as
// the investigation, on the question, with its own evidence IDs. Saves go
// through patchIncident, at most every QUESTION_SAVE_MS, so the
// investigation's fields and other writers' changes are left alone.
export class QuestionRecorder implements StepRecorder, ThoughtRecorder {
  readonly queriedServices = new Set<string>();
  private counters = new Map<EvidenceKind, number>();
  private writes: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    public question: Question,
    readonly incidentId: string,
    readonly service: string,
    private save: (incidentId: string, question: Question) => Promise<void> = saveQuestion,
  ) {}

  startStep(id: string, tool: ToolName, input: Record<string, unknown>) {
    this.question.steps.push(runningStep(id, tool, input));
    this.persist();
  }

  completeStep(id: string, tool: ToolName, summary: string, drafts: EvidenceDraft[]): Evidence[] {
    const prefix = questionEvidencePrefix(this.question.id);
    const evidence = drafts.map((d) => assignId(this.counters, prefix, d, tool));
    this.question.evidence.push(...evidence);
    this.updateStep(id, (step) => completedStep(step, summary, evidence));
    return evidence;
  }

  failStep(id: string, error: string) {
    this.updateStep(id, (step) => failedStep(step, error));
  }

  startThought(id: string) {
    this.question.thoughts = startedThought(this.question.thoughts, id);
    this.persist();
  }

  endThought(id: string, out: Pick<Thought, "reasoning" | "reasoningKind" | "text">) {
    this.question.thoughts = endedThought(this.question.thoughts, id, out);
    this.persist();
  }

  dropUnfinishedThoughts() {
    if (!this.question.thoughts) return;
    this.question.thoughts = finishedThoughts(this.question.thoughts);
    this.persist();
  }

  appendAnswer(text: string) {
    this.question.answer += text;
    this.persist();
  }

  update(patch: Partial<Question>) {
    this.question = { ...this.question, ...patch };
    this.persist();
  }

  // Saves what is pending now, and resolves once every save has landed.
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.write();
    }
    return this.writes;
  }

  private updateStep(id: string, fn: (step: Step) => Step) {
    this.question.steps = this.question.steps.map((s) => (s.id === id ? fn(s) : s));
    this.persist();
  }

  private persist() {
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.write();
    }, QUESTION_SAVE_MS);
  }

  private write() {
    const snapshot = structuredClone(this.question);
    this.writes = this.writes
      .then(() => this.save(this.incidentId, snapshot))
      .catch((err) => console.error("[triage] failed to save question", this.incidentId, snapshot.id, err));
  }
}

// Replaces the question on the incident (or appends it), leaving the rest
// as stored.
async function saveQuestion(incidentId: string, question: Question): Promise<void> {
  await patchIncident(incidentId, (i) => {
    const questions = i.questions ?? [];
    const exists = questions.some((q) => q.id === question.id);
    return {
      ...i,
      questions: exists ? questions.map((q) => (q.id === question.id ? question : q)) : [...questions, question],
    };
  });
}

function assignId(counters: Map<EvidenceKind, number>, prefix: string, draft: EvidenceDraft, tool: ToolName): Evidence {
  const n = (counters.get(draft.kind) ?? 0) + 1;
  counters.set(draft.kind, n);
  return { ...draft, id: `${prefix}${draft.kind}_${n}`, tool } as Evidence;
}

function runningStep(id: string, tool: ToolName, input: Record<string, unknown>): Step {
  return { id, tool, input, status: "running", startedAt: new Date().toISOString(), evidenceIds: [] };
}

function completedStep(step: Step, summary: string, evidence: Evidence[]): Step {
  return {
    ...step,
    status: "completed",
    summary,
    evidenceIds: evidence.map((e) => e.id),
    durationMs: Date.now() - Date.parse(step.startedAt),
  };
}

function failedStep(step: Step, error: string): Step {
  return { ...step, status: "error", error, durationMs: Date.now() - Date.parse(step.startedAt) };
}

function startedThought(thoughts: Thought[] | undefined, id: string): Thought[] {
  return [...(thoughts ?? []), { id, startedAt: new Date().toISOString() }];
}

function endedThought(
  thoughts: Thought[] | undefined,
  id: string,
  out: Pick<Thought, "reasoning" | "reasoningKind" | "text">,
): Thought[] {
  const list = thoughts ?? [];
  if (!out.reasoning && !out.text) return list.filter((t) => t.id !== id);
  return list.map((t) => (t.id === id ? { ...t, ...out, durationMs: Date.now() - Date.parse(t.startedAt) } : t));
}

function finishedThoughts(thoughts: Thought[]): Thought[] {
  return thoughts.filter((t) => t.durationMs !== undefined);
}
