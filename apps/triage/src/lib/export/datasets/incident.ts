import type { Evidence, Fix, Incident, InvestigationStep, MetricPoint, Question, Run, Thought } from "@/lib/investigation/schema";
import { costOf } from "@/lib/models/pricing";
import { type Cell, type Column, defineDataset, type ExportSubject } from "../dataset";

// An incident's record and the raw evidence behind what the AI claimed, as
// files, so anyone can check a claim against what the tools returned. Every
// evidence row names its source: the investigation, or the Ask question
// (q_1) whose tool calls gathered it, as evidence IDs are only unique
// together with it in mind.

// What an incident's exports are about, for the file's name and JSON envelope.
export function incidentSubject(incident: Pick<Incident, "id" | "title">): ExportSubject {
  return { kind: "incident", id: incident.id, name: incident.title };
}

export const INVESTIGATION = "investigation";

type EvidenceOf<K extends Evidence["kind"]> = Extract<Evidence, { kind: K }>;
export type Sourced<K extends Evidence["kind"]> = { source: string; evidence: EvidenceOf<K> };

// As the page combines them: the investigation's, then each question's in
// the order asked.
export function sourcedEvidence(incident: Pick<Incident, "evidence" | "questions">): { source: string; evidence: Evidence }[] {
  return [
    ...incident.evidence.map((evidence) => ({ source: INVESTIGATION, evidence })),
    ...(incident.questions ?? []).flatMap((q) => q.evidence.map((evidence) => ({ source: q.id, evidence }))),
  ];
}

function ofKind<K extends Evidence["kind"]>(incident: Pick<Incident, "evidence" | "questions">, kind: K): Sourced<K>[] {
  return sourcedEvidence(incident).filter((s): s is Sourced<K> => s.evidence.kind === kind);
}

// The columns as a JSON object, for a dataset that swaps one of them for
// the structured value (the CSV can only hold its JSON text).
function fromColumns<Row>(columns: Column<Row>[], row: Row): Record<string, unknown> {
  return Object.fromEntries(columns.map((c) => [c.key, c.value(row) ?? null]));
}

const sourceColumns = [
  { key: "evidence_id", value: (r: { evidence: Evidence }) => r.evidence.id },
  { key: "source", value: (r: { source: string }) => r.source },
];

// The whole stored record, as the API returns it. An incident holds no
// secret (keys and webhook URLs live in settings), so nothing is left out.
export const incidentRecord = defineDataset<Incident>({
  id: "incident",
  name: "Incident record",
  columns: [],
  json: (incident) => incident,
  formats: ["json"],
});

export const evidenceLogs = defineDataset<Sourced<"log">>({
  id: "evidence-logs",
  name: "Logs",
  columns: [
    ...sourceColumns,
    { key: "observed_at", value: (r) => r.evidence.observedAt },
    { key: "service", value: (r) => r.evidence.service },
    { key: "level", value: (r) => r.evidence.level },
    { key: "message", value: (r) => r.evidence.message },
    { key: "trace_id", value: (r) => r.evidence.traceId },
    { key: "count", value: (r) => r.evidence.count },
    { key: "summary", value: (r) => r.evidence.summary },
  ],
  formats: ["csv", "json", "ndjson"],
});

export const logRows = (incident: Pick<Incident, "evidence" | "questions">) => ofKind(incident, "log");

const spanColumns: Column<Sourced<"span">>[] = [
  ...sourceColumns,
  { key: "observed_at", value: (r) => r.evidence.observedAt },
  { key: "service", value: (r) => r.evidence.service },
  { key: "trace_id", value: (r) => r.evidence.traceId },
  { key: "name", value: (r) => r.evidence.name },
  { key: "duration_ms", value: (r) => r.evidence.durationMs },
  { key: "status", value: (r) => r.evidence.status },
  { key: "attributes", value: (r) => JSON.stringify(r.evidence.attributes) },
];

export const evidenceSpans = defineDataset<Sourced<"span">>({
  id: "evidence-spans",
  name: "Spans",
  columns: spanColumns,
  json: (r) => ({ ...fromColumns(spanColumns, r), attributes: r.evidence.attributes }),
  formats: ["csv", "json"],
});

export const spanRows = (incident: Pick<Incident, "evidence" | "questions">) => ofKind(incident, "span");

// One row per point. A metric with no points still gets a row, its time and
// value empty, so its baseline and observed values aren't lost with it.
export type MetricRow = Sourced<"metric"> & { point?: MetricPoint };

export const evidenceMetrics = defineDataset<MetricRow>({
  id: "evidence-metrics",
  name: "Metrics",
  columns: [
    ...sourceColumns,
    { key: "metric", value: (r) => r.evidence.metric },
    { key: "unit", value: (r) => r.evidence.unit },
    { key: "time", value: (r) => r.point?.t },
    { key: "value", value: (r) => r.point?.value },
    { key: "baseline", value: (r) => r.evidence.baseline },
    { key: "observed", value: (r) => r.evidence.observed },
  ],
  formats: ["csv", "json"],
});

export function metricRows(incident: Pick<Incident, "evidence" | "questions">): MetricRow[] {
  return ofKind(incident, "metric").flatMap((s) => (s.evidence.series.length ? s.evidence.series.map((point) => ({ ...s, point })) : [s]));
}

// One row per row returned. A query that returned none still gets a row, its
// row_index and row empty: "nothing matched" is evidence too.
export type DbRow = Sourced<"db"> & { index?: number; row?: Record<string, string | number | null> };

const dbColumns: Column<DbRow>[] = [
  ...sourceColumns,
  { key: "query", value: (r) => r.evidence.query },
  { key: "row_index", value: (r) => r.index },
  { key: "row", value: (r) => (r.row ? JSON.stringify(r.row) : undefined) },
];

export const evidenceDb = defineDataset<DbRow>({
  id: "evidence-db",
  name: "Database rows",
  columns: dbColumns,
  json: (r) => ({ ...fromColumns(dbColumns, r), row: r.row ?? null }),
  formats: ["csv", "json"],
});

export function dbRows(incident: Pick<Incident, "evidence" | "questions">): DbRow[] {
  return ofKind(incident, "db").flatMap((s) => (s.evidence.rows.length ? s.evidence.rows.map((row, index) => ({ ...s, index, row })) : [s]));
}

// The investigation as it ran: how it ran (provider, model, tokens) first,
// then the model's thoughts and its tool calls in time order, as the
// timeline's step-by-step view lays them out.
export type TraceRow = { kind: "run"; run: Run } | { kind: "thought"; thought: Thought } | { kind: "step"; step: InvestigationStep };

// Every row has every key, null where it doesn't apply, so a reader can
// filter on any of them.
function traceRecord(row: TraceRow): Record<string, unknown> {
  const blank = {
    kind: row.kind,
    id: null,
    started_at: null,
    duration_ms: null,
    tool: null,
    status: null,
    input: null,
    summary: null,
    evidence_ids: null,
    error: null,
    turn: null,
    reasoning: null,
    reasoning_kind: null,
    text: null,
    source: null,
    provider: null,
    model: null,
    reasoning_effort: null,
    model_steps: null,
    model_retries: null,
    input_tokens: null,
    cached_input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    cost_usd: null,
  };
  switch (row.kind) {
    case "run": {
      const { run } = row;
      return {
        ...blank,
        started_at: run.startedAt,
        duration_ms: run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null,
        status: run.error ? "error" : run.finishedAt ? "completed" : "running",
        error: run.error ?? null,
        source: run.source,
        provider: run.provider ?? null,
        model: run.model,
        reasoning_effort: run.reasoningEffort ?? null,
        model_steps: run.modelSteps ?? null,
        model_retries: run.modelRetries ?? null,
        input_tokens: run.inputTokens ?? null,
        cached_input_tokens: run.cachedInputTokens ?? null,
        output_tokens: run.outputTokens ?? null,
        reasoning_tokens: run.reasoningTokens ?? null,
        cost_usd: run.inputTokens === undefined ? null : (costOf(run, run.provider, run.model) ?? null),
      };
    }
    case "thought": {
      const { thought: t } = row;
      return {
        ...blank,
        id: t.id,
        started_at: t.startedAt,
        duration_ms: t.durationMs ?? null,
        reasoning: t.reasoning ?? null,
        reasoning_kind: t.reasoningKind ?? null,
        text: t.text ?? null,
      };
    }
    case "step": {
      const { step: s } = row;
      return {
        ...blank,
        id: s.id,
        started_at: s.startedAt,
        duration_ms: s.durationMs ?? null,
        tool: s.tool,
        status: s.status,
        input: s.input,
        summary: s.summary ?? null,
        evidence_ids: s.evidenceIds,
        error: s.error ?? null,
        // The thought ID of the model call that asked for it.
        turn: s.turn ?? null,
      };
    }
  }
}

export const investigationTrace = defineDataset<TraceRow>({
  id: "investigation-trace",
  name: "Investigation trace",
  columns: [],
  json: traceRecord,
  formats: ["json", "ndjson"],
});

// A thought comes before a tool call that started at the same moment: the
// model call ends, then the calls it asked for run. Otherwise in the order
// recorded.
export function traceRows({ run, steps, thoughts = [] }: { run?: Run; steps: InvestigationStep[]; thoughts?: Thought[] }): TraceRow[] {
  const events = [
    ...thoughts.map((thought) => ({ at: Date.parse(thought.startedAt), rank: 0, row: { kind: "thought", thought } as TraceRow })),
    ...steps.map((step) => ({ at: Date.parse(step.startedAt), rank: 1, row: { kind: "step", step } as TraceRow })),
  ].sort((a, b) => a.at - b.at || a.rank - b.rank);
  return [...(run ? [{ kind: "run", run } as TraceRow] : []), ...events.map((e) => e.row)];
}

// The fix's unified diff, byte for byte as stored, so `git apply` takes it.
// git refuses a patch whose last line has no newline, so one is added then.
export const fixPatch = defineDataset<Pick<Fix, "patch">>({
  id: "fix-patch",
  name: "Fix patch",
  columns: [],
  text: { patch: (rows) => rows.map(({ patch }) => (patch.endsWith("\n") ? patch : `${patch}\n`)).join("") },
  formats: ["patch"],
});

// Each Ask question with its answer and what it cites: the evidence IDs as
// written in the answer, each with its one-line summary to look it up by.
export type AnswerRow = {
  incident: Pick<Incident, "id" | "title">;
  question: Question;
  cited: { id: string; summary?: string }[];
};

export function answerRows(incident: Incident): AnswerRow[] {
  const summaries = new Map(sourcedEvidence(incident).map(({ evidence }) => [evidence.id, evidence.summary]));
  return (incident.questions ?? []).map((question) => ({
    incident: { id: incident.id, title: incident.title },
    question,
    cited: question.citedIds.map((id) => ({ id, summary: summaries.get(id) })),
  }));
}

const answerColumns: Column<AnswerRow>[] = [
  { key: "question_id", value: (r) => r.question.id },
  { key: "question", value: (r) => r.question.text },
  { key: "has_screenshot", value: (r) => r.question.image !== undefined },
  { key: "asked_at", value: (r) => r.question.askedAt },
  { key: "answered_at", value: (r) => r.question.answeredAt },
  { key: "status", value: (r) => r.question.status },
  { key: "mode", value: (r) => r.question.mode },
  { key: "provider", value: (r) => r.question.provider },
  { key: "model", value: (r) => r.question.model },
  { key: "reasoning_effort", value: (r) => r.question.reasoningEffort },
  { key: "answer", value: (r) => r.question.answer },
  { key: "error", value: (r) => r.question.error },
];

export const askAnswers = defineDataset<AnswerRow>({
  id: "ask-answers",
  name: "Ask answers",
  columns: answerColumns,
  json: (r) => ({
    ...fromColumns(answerColumns, r),
    cited_evidence: r.cited.map((c) => ({ evidence_id: c.id, summary: c.summary ?? null })),
    // Cited in the answer, found in no evidence: the page strikes these.
    unknown_evidence_ids: r.question.unknownIds,
  }),
  text: { md: answersMarkdown },
  formats: ["md", "json"],
});

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const code = (id: string) => `\`${id}\``;

function answersMarkdown(rows: AnswerRow[]): string {
  const incident = rows[0]?.incident;
  const lines: string[] = [];
  if (incident) {
    lines.push(`# Questions on "${oneLine(incident.title)}"`, "", `Incident ${code(incident.id)}. Answers cite evidence by ID in square brackets; each answer's cited evidence is listed under it.`, "");
  }
  rows.forEach(({ question: q, cited }, i) => {
    lines.push(`## ${i + 1}. ${oneLine(q.text)}`, "");
    const when: Cell[] = [
      `Asked ${q.askedAt}`,
      q.image && "with a screenshot (not exported)",
      q.answeredAt && `answered ${q.answeredAt}`,
      q.model && `by ${q.model}`,
    ];
    lines.push(when.filter(Boolean).join(" · "), "");
    if (q.status === "failed") lines.push(`_Not answered: ${oneLine(q.error ?? "the answer failed")}_`, "");
    else if (q.status === "answering") lines.push("_Still being answered when exported._", "");
    if (q.answer.trim()) lines.push(q.answer.trim(), "");
    if (cited.length || q.unknownIds.length) {
      lines.push("Cited evidence:", "");
      for (const c of cited) lines.push(`- ${code(c.id)}: ${c.summary ? oneLine(c.summary) : "(no summary)"}`);
      for (const id of q.unknownIds) lines.push(`- ${code(id)}: not in the incident's evidence`);
      lines.push("");
    }
  });
  return lines.join("\n").replace(/\n+$/, "\n");
}
