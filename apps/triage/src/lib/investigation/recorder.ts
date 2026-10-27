import type { Evidence, EvidenceKind, Incident, InvestigationReport, ToolName } from "./schema";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// Evidence as a tool produces it; the recorder assigns the ID.
export type EvidenceDraft = DistributiveOmit<Evidence, "id" | "tool">;

// Owns the incident while the agent runs: assigns evidence IDs, tracks
// steps and queried services, and saves after every change so the UI can
// follow along. Saves are serialized so a slow write never lands after a
// newer one.
export class InvestigationRecorder {
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

  startStep(id: string, tool: ToolName, input: Record<string, unknown>) {
    this.incident.steps.push({
      id,
      tool,
      input,
      status: "running",
      startedAt: new Date().toISOString(),
      evidenceIds: [],
    });
    this.persist();
  }

  completeStep(id: string, tool: ToolName, summary: string, drafts: EvidenceDraft[]): Evidence[] {
    const evidence = drafts.map((d) => this.assignId(d, tool));
    this.incident.evidence.push(...evidence);
    this.updateStep(id, (step) => ({
      ...step,
      status: "completed",
      summary,
      evidenceIds: evidence.map((e) => e.id),
      durationMs: Date.now() - Date.parse(step.startedAt),
    }));
    return evidence;
  }

  failStep(id: string, error: string) {
    this.updateStep(id, (step) => ({
      ...step,
      status: "error",
      error,
      durationMs: Date.now() - Date.parse(step.startedAt),
    }));
  }

  update(patch: Partial<Incident>) {
    this.incident = { ...this.incident, ...patch };
    this.persist();
  }

  flush(): Promise<void> {
    return this.writes;
  }

  private assignId(draft: EvidenceDraft, tool: ToolName): Evidence {
    const n = (this.counters.get(draft.kind) ?? 0) + 1;
    this.counters.set(draft.kind, n);
    return { ...draft, id: `ev_${draft.kind}_${n}`, tool } as Evidence;
  }

  private updateStep(id: string, fn: (step: Incident["steps"][number]) => Incident["steps"][number]) {
    this.incident.steps = this.incident.steps.map((s) => (s.id === id ? fn(s) : s));
    this.persist();
  }

  private persist() {
    const snapshot = structuredClone(this.incident);
    this.writes = this.writes
      .then(() => this.save(snapshot))
      .catch((err) => console.error("[triage] failed to save incident", snapshot.id, err));
  }
}
