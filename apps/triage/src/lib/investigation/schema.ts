import { z } from "zod";

// Contract between the Triage agent and the UI. The agent emits a `report`
// (structured output); tools emit `evidence`; the app adds the fix,
// sandbox validation and approval. Every claim points at evidence by ID so
// the UI can render it and the verifier can strike claims whose evidence
// does not exist.

export const toolNameSchema = z.enum([
  "query_logs",
  "query_traces",
  "query_metrics",
  "db_diagnostics",
  "read_source",
  "git_log",
  "deploy_history",
]);
export type ToolName = z.infer<typeof toolNameSchema>;

const evidenceId = z
  .string()
  .regex(/^ev_[a-z0-9_]+$/)
  .describe("ID of an evidence item returned by a tool, e.g. ev_log_3");

const timestamp = z.iso.datetime();

export const metricPointSchema = z.object({
  t: timestamp,
  value: z.number(),
});
export type MetricPoint = z.infer<typeof metricPointSchema>;

const evidenceBase = {
  id: evidenceId,
  tool: toolNameSchema,
  summary: z.string().describe("One line a human can scan"),
  observedAt: timestamp.optional(),
};

export const evidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    ...evidenceBase,
    kind: z.literal("log"),
    service: z.string(),
    level: z.enum(["debug", "info", "warn", "error"]),
    message: z.string(),
    traceId: z.string().optional(),
    count: z.number().int().positive().optional(),
  }),
  z.object({
    ...evidenceBase,
    kind: z.literal("span"),
    service: z.string(),
    traceId: z.string(),
    name: z.string(),
    durationMs: z.number(),
    status: z.enum(["ok", "error"]),
    attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  }),
  z.object({
    ...evidenceBase,
    kind: z.literal("metric"),
    metric: z.string(),
    unit: z.string(),
    baseline: z.number(),
    observed: z.number(),
    series: z.array(metricPointSchema),
  }),
  z.object({
    ...evidenceBase,
    kind: z.literal("db"),
    query: z.string(),
    rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
  }),
  z.object({
    ...evidenceBase,
    kind: z.literal("source"),
    file: z.string(),
    startLine: z.number().int().positive(),
    code: z.string(),
  }),
  z.object({
    ...evidenceBase,
    kind: z.literal("commit"),
    sha: z.string(),
    author: z.string(),
    message: z.string(),
    files: z.array(z.string()),
  }),
]);
export type Evidence = z.infer<typeof evidenceSchema>;
export type EvidenceKind = Evidence["kind"];

export const investigationStepSchema = z.object({
  id: z.string(),
  tool: toolNameSchema,
  input: z.record(z.string(), z.unknown()),
  status: z.enum(["running", "completed", "error"]),
  startedAt: timestamp,
  durationMs: z.number().optional(),
  summary: z.string().optional(),
  evidenceIds: z.array(evidenceId),
  error: z.string().optional(),
});
export type InvestigationStep = z.infer<typeof investigationStepSchema>;

const claimSchema = z.object({
  text: z.string(),
  evidenceIds: z.array(evidenceId).min(1).describe("Every claim must cite evidence"),
});
export type Claim = z.infer<typeof claimSchema>;

export const hypothesisSchema = z.object({
  id: z.string(),
  title: z.string(),
  confidence: z.number().min(0).max(1),
  status: z.enum(["leading", "plausible", "rejected"]),
  causalChain: z
    .object({
      symptom: claimSchema,
      propagation: claimSchema,
      rootCause: claimSchema,
    })
    .describe("Symptom -> propagation -> root cause, each pinned to evidence"),
  rejectedBecause: claimSchema.optional(),
});
export type Hypothesis = z.infer<typeof hypothesisSchema>;

export const verdictSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("root_cause"), hypothesisId: z.string() }),
  z.object({ kind: z.literal("healthy"), rationale: claimSchema }),
  z.object({ kind: z.literal("inconclusive"), missing: z.array(z.string()) }),
]);
export type Verdict = z.infer<typeof verdictSchema>;

export const reportSummarySchema = z
  .string()
  .max(300)
  .describe(
    "What happened, for the on-call engineer, in plain English: one or two short sentences, under 40 words. Say what broke, why, and since when. Name a file, function or commit only if it is the cause. No metric names, tool names or evidence IDs.",
  );

// What the model returns as structured output at the end of Stage 2.
// `summary` is optional here only so reports saved before it existed still
// load; submit_report requires it.
export const investigationReportSchema = z.object({
  summary: reportSummarySchema.optional(),
  hypotheses: z.array(hypothesisSchema),
  verdict: verdictSchema,
  servicesQueried: z.array(z.string()),
});
export type InvestigationReport = z.infer<typeof investigationReportSchema>;

export const fixSchema = z.object({
  summary: z.string(),
  patch: z.string().describe("Unified diff"),
  files: z.array(z.string()),
  regressionTest: z.object({ file: z.string(), name: z.string() }),
  risk: z.enum(["low", "medium", "high"]),
  touchesData: z.boolean(),
});
export type Fix = z.infer<typeof fixSchema>;

export const testCaseSchema = z.object({
  name: z.string(),
  status: z.enum(["passed", "failed", "skipped"]),
  durationMs: z.number(),
  error: z.string().optional(),
});
export type TestCase = z.infer<typeof testCaseSchema>;

export const sandboxRunSchema = z.object({
  label: z.string(),
  ref: z.enum(["original", "patched"]),
  command: z.string(),
  exitCode: z.number().int(),
  durationMs: z.number(),
  tests: z.array(testCaseSchema),
  // A request replayed against the app, when the run included one.
  repro: z
    .object({
      request: z.string(),
      status: z.number().int(),
      latencyMs: z.number(),
    })
    .optional(),
  output: z.string(),
});
export type SandboxRun = z.infer<typeof sandboxRunSchema>;

export const approvalSchema = z.object({
  state: z.enum(["pending", "approved", "denied"]),
  requestedAt: timestamp,
  decidedAt: timestamp.optional(),
  decidedBy: z.string().optional(),
  reason: z.string().optional(),
  // Stage 5, after an approval: opening the PR, then its URL or why it failed.
  prState: z.enum(["opening", "opened", "failed"]).optional(),
  prError: z.string().optional(),
  prUrl: z.url().optional(),
});
export type Approval = z.infer<typeof approvalSchema>;

// Stages 3 and 4 as they run: the model writes a fix and a regression test,
// the sandbox proves them, and a failed proof goes back to the model.
export const fixRunSchema = z.object({
  status: z.enum(["writing", "testing", "proven", "failed"]),
  attempt: z.number().int().describe("Submissions so far, counting the one being tested"),
  // The fix stage's provider and model.
  provider: z.string().optional(),
  model: z.string().optional(),
  rejections: z.array(z.string()).optional().describe("Why each rejected submission failed, first line only"),
  startedAt: timestamp,
  finishedAt: timestamp.optional(),
  modelSteps: z.number().int().optional(),
  inputTokens: z.number().int().optional(),
  outputTokens: z.number().int().optional(),
  error: z.string().optional(),
});
export type FixRun = z.infer<typeof fixRunSchema>;

export const incidentStatusSchema = z.enum([
  "investigating",
  "diagnosed",
  "awaiting_approval",
  "resolved",
  "healthy",
  "failed",
]);
export type IncidentStatus = z.infer<typeof incidentStatusSchema>;

// How the investigation ran, for the UI and the benchmark.
export const runSchema = z.object({
  source: z.string().describe("Telemetry source, e.g. scenario:pool-leak"),
  // Where the investigate stage's model ran (see lib/models). Missing on
  // runs from before stages had their own models.
  provider: z.string().optional(),
  model: z.string(),
  startedAt: timestamp,
  finishedAt: timestamp.optional(),
  modelSteps: z.number().int().optional(),
  inputTokens: z.number().int().optional(),
  outputTokens: z.number().int().optional(),
  rejectedReports: z.number().int().optional(),
  error: z.string().optional(),
});
export type Run = z.infer<typeof runSchema>;

export const incidentSchema = z.object({
  id: z.string(),
  title: z.string(),
  service: z.string(),
  severity: z.enum(["sev1", "sev2", "sev3"]),
  status: incidentStatusSchema,
  detectedAt: timestamp,
  // Who started it: Triage's watch, when an alert crossed its limit, or a
  // person. Missing on incidents from before the watch existed.
  openedBy: z.enum(["watch", "person"]).optional(),
  trigger: z.object({
    metric: z.string(),
    unit: z.string(),
    threshold: z.number(),
    observed: z.number(),
    series: z.array(metricPointSchema),
  }),
  steps: z.array(investigationStepSchema),
  evidence: z.array(evidenceSchema),
  report: investigationReportSchema.optional(),
  fix: fixSchema.optional(),
  validation: z.array(sandboxRunSchema).optional(),
  fixRun: fixRunSchema.optional(),
  approval: approvalSchema.optional(),
  run: runSchema.optional(),
});
export type Incident = z.infer<typeof incidentSchema>;

// Verifier: every evidence ID cited in the report must exist. Returns the
// IDs that do not, so the UI can strike the claims that cite them.
export function findUnknownEvidenceIds(
  report: InvestigationReport,
  evidence: Evidence[],
): string[] {
  const known = new Set(evidence.map((e) => e.id));
  const claims = report.hypotheses.flatMap((h) => [
    h.causalChain.symptom,
    h.causalChain.propagation,
    h.causalChain.rootCause,
    ...(h.rejectedBecause ? [h.rejectedBecause] : []),
  ]);
  if (report.verdict.kind === "healthy") claims.push(report.verdict.rationale);
  const cited = claims.flatMap((c) => c.evidenceIds);
  return [...new Set(cited.filter((id) => !known.has(id)))];
}

// Rules the JSON schema cannot express; checked after the model responds.
export function reportProblems(report: InvestigationReport): string[] {
  const problems: string[] = [];
  const { hypotheses, verdict } = report;
  if (verdict.kind === "root_cause") {
    if (hypotheses.length < 3) problems.push("root_cause verdict needs at least 3 hypotheses");
    const chosen = hypotheses.find((h) => h.id === verdict.hypothesisId);
    if (!chosen) problems.push(`verdict cites unknown hypothesis ${verdict.hypothesisId}`);
    else if (chosen.status !== "leading") problems.push("verdict hypothesis must be leading");
  }
  if (verdict.kind === "healthy" && hypotheses.some((h) => h.status === "leading")) {
    problems.push("healthy verdict cannot have a leading hypothesis");
  }
  for (const h of hypotheses) {
    if (h.status === "rejected" && !h.rejectedBecause) {
      problems.push(`rejected hypothesis ${h.id} needs rejectedBecause`);
    }
  }
  const ids = hypotheses.map((h) => h.id);
  if (new Set(ids).size !== ids.length) problems.push("hypothesis ids must be unique");
  return problems;
}
