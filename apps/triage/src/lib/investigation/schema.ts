import { z } from "zod";
import { templateSchema } from "./postmortem/template";

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

export const evidenceId = z
  .string()
  .regex(/^ev_[a-z0-9_]+$/)
  .describe("ID of an evidence item returned by a tool, e.g. ev_log_3");

const timestamp = z.iso.datetime();

export const metricPointSchema = z.object({
  t: timestamp,
  value: z.number(),
});
export type MetricPoint = z.infer<typeof metricPointSchema>;
// A point on a chart; a null value is a gap in the line (a bucket with
// nothing to measure, on the live page).
export type ChartPoint = MetricPoint | { t: string; value: null };

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

// One model call in the investigation: what the model thought before the
// tool calls it then made. `reasoning` is its raw thinking where the
// provider returns it (open weights through OpenRouter or a local server),
// or the provider's summary of it (Meta's API: the raw thinking stays
// private there). No duration while the model is still working.
export const thoughtSchema = z.object({
  id: z.string(),
  startedAt: timestamp,
  durationMs: z.number().optional(),
  reasoning: z.string().optional(),
  reasoningKind: z.enum(["raw", "summary"]).optional(),
  // What the model wrote alongside its tool calls, if anything.
  text: z.string().optional(),
});
export type Thought = z.infer<typeof thoughtSchema>;

export const claimSchema = z.object({
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

// The alert's metric after a mitigation is applied, watched until it is back
// under the threshold or the watch gives up. Stops at a measured status; the
// incident's Resolved transition is separate.
export const recoverySchema = z.object({
  metric: z.string(),
  threshold: z.number(),
  since: timestamp,
  series: z.array(metricPointSchema),
  status: z.enum(["watching", "recovered", "not_recovered"]),
  recoveredAt: timestamp.optional(),
  checkedAt: timestamp.optional(),
  note: z.string().optional(),
});
export type Recovery = z.infer<typeof recoverySchema>;

// A fast, reversible step to stop the bleeding before the fix ships: turn off
// the flag or roll back the deploy the diagnosis cites. Proposed by a rule
// over the evidence (mitigation/propose.ts), approved by a person, then run
// against the service and watched until the alert recovers.
export const mitigationSchema = z.object({
  kind: z.enum(["flag_off", "rollback"]),
  target: z.string().describe("The flag name, or the deploy's sha"),
  title: z.string(),
  why: claimSchema,
  steps: z.array(z.string()),
  undo: z.string(),
  risk: z.enum(["very_low", "low", "medium"]),
  state: z.enum(["proposed", "approved", "denied", "running", "applied", "failed"]),
  proposedAt: timestamp,
  decidedAt: timestamp.optional(),
  appliedAt: timestamp.optional(),
  output: z.string().optional(),
  error: z.string().optional(),
  recovery: recoverySchema.optional(),
});
export type Mitigation = z.infer<typeof mitigationSchema>;

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
  // When the PR was merged, as the PR check last saw it.
  prMergedAt: timestamp.optional(),
});
export type Approval = z.infer<typeof approvalSchema>;

// Stages 3 and 4 as they run: the model writes a fix and a regression test,
// the sandbox proves them, and a failed proof goes back to the model.
export const fixRunSchema = z.object({
  // declined: the model judged the diagnosis isn't a code defect it should
  // fix (see declinedBecause), instead of fixing something else.
  status: z.enum(["writing", "testing", "proven", "failed", "declined"]),
  declinedBecause: z.string().optional(),
  attempt: z.number().int().describe("Submissions so far, counting the one being tested"),
  // The fix stage's provider and model.
  provider: z.string().optional(),
  model: z.string().optional(),
  rejections: z.array(z.string()).optional().describe("Why each rejected submission failed, first line only"),
  startedAt: timestamp,
  // As on the investigation's run: the fix stage's host waking up.
  wakingSince: timestamp.optional(),
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
  // Set while the model's host wakes from scaled to zero (Modal), before
  // the first model call; cleared once it answers.
  wakingSince: timestamp.optional(),
  finishedAt: timestamp.optional(),
  modelSteps: z.number().int().optional(),
  inputTokens: z.number().int().optional(),
  outputTokens: z.number().int().optional(),
  rejectedReports: z.number().int().optional(),
  error: z.string().optional(),
});
export type Run = z.infer<typeof runSchema>;

// A follow-up question on a finished incident, answered by a small,
// bounded investigation with the same read-only tools. Its steps and
// evidence live on the question; evidence IDs carry the question's ID
// (ev_q2_span_1) so they never collide with the investigation's. `answer`
// grows while it streams; the citations are parsed from it at the end.
export const questionSchema = z.object({
  id: z.string().regex(/^q_\d+$/).describe("Sequential per incident; also the evidence ID prefix"),
  text: z.string().min(1).max(500),
  askedAt: timestamp,
  answeredAt: timestamp.optional().describe("Set on finish or failure"),
  status: z.enum(["answering", "answered", "failed"]),
  error: z.string().optional(),
  answer: z.string().describe("Inline [ev_…] citations; grows while streaming"),
  citedIds: z.array(z.string()),
  unknownIds: z.array(z.string()),
  steps: z.array(investigationStepSchema),
  evidence: z.array(evidenceSchema),
  thoughts: z.array(thoughtSchema).optional(),
  // evidence_only: no telemetry source to rebuild (bundled examples), so the
  // answer comes from the recorded evidence without tools.
  mode: z.enum(["tools", "evidence_only"]),
  provider: z.string().optional(),
  model: z.string(),
  inputTokens: z.number().int().optional(),
  outputTokens: z.number().int().optional(),
});
export type Question = z.infer<typeof questionSchema>;

// A fix a reviewer denied with feedback, kept when the fix stage reruns.
export const fixAttemptSchema = z.object({
  fix: fixSchema,
  validation: z.array(sandboxRunSchema).optional(),
  fixRun: fixRunSchema,
  approval: approvalSchema,
});
export type FixAttempt = z.infer<typeof fixAttemptSchema>;

// An action item in the postmortem. Owner and due date are left for the
// team: the export has blank columns for them.
export const postmortemActionItemSchema = z.object({
  title: z.string(),
  kind: z.enum(["fix_this", "prevent_class", "detect_sooner", "mitigate_faster"]),
  priority: z.enum(["P1", "P2", "P3"]),
  evidenceIds: z.array(evidenceId).optional(),
});
export type PostmortemActionItem = z.infer<typeof postmortemActionItemSchema>;

// The blameless postmortem's judgment, written by one model call over the
// recorded evidence (postmortem/writer.ts). Everything else in the
// document (impact numbers, timeline, fix, evidence appendix) is rendered
// from the incident itself. One record; writing again replaces it. The
// content fields are absent while it is being written or after a failure.
export const postmortemSchema = z.object({
  status: z.enum(["writing", "ready", "failed"]),
  startedAt: timestamp,
  finishedAt: timestamp.optional(),
  error: z.string().optional(),
  provider: z.string().optional(),
  model: z.string(),
  inputTokens: z.number().int().optional(),
  outputTokens: z.number().int().optional(),
  summary: z.string().optional().describe("Three sentences, under 80 words: what happened, impact, duration. No evidence IDs."),
  impact: claimSchema.optional().describe("Who was affected and how, cited"),
  contributingFactors: z.array(claimSchema).optional().describe("2 to 5 conditions that each had to hold, cited"),
  wentWell: z.array(claimSchema).optional(),
  wentBadly: z.array(claimSchema).optional(),
  lucky: z.array(z.string()).optional().describe("What could have made it worse"),
  actionItems: z.array(postmortemActionItemSchema).optional(),
  // The template's custom sections as written, named as the template named them.
  custom: z.array(z.object({ id: z.string(), name: z.string(), text: z.string(), evidenceIds: z.array(evidenceId) })).optional(),
  // The template this was written with, kept so it renders in the same shape
  // later. Absent on records from before templates: they are the default.
  template: templateSchema.optional(),
  citedIds: z.array(z.string()).optional(),
  unknownIds: z.array(z.string()).optional(),
});
export type Postmortem = z.infer<typeof postmortemSchema>;

// One time the incident was reopened: by the verification (the metric
// climbed back inside the quiet window), by the watch (a breach shortly
// after a resolution) or by a person. resolvedAt is the resolution it undid.
export const reopeningSchema = z.object({
  at: timestamp,
  by: z.enum(["verification", "watch", "person"]),
  why: z.string(),
  resolvedAt: timestamp.optional(),
  value: z.number().optional(),
});
export type Reopening = z.infer<typeof reopeningSchema>;

// The quiet window after a recovery: the alert's metric watched for
// windowMinutes completed minutes under its threshold. Resolves the
// incident when it completes; reopens it on the first minute over.
export const verificationSchema = z.object({
  after: z.enum(["mitigation", "fix", "manual"]),
  since: timestamp,
  windowMinutes: z.number().int().positive(),
  metric: z.string(),
  threshold: z.number(),
  series: z.array(metricPointSchema),
  status: z.enum(["verifying", "resolved", "breached", "stopped"]),
  startedAt: timestamp,
  checkedAt: timestamp.optional(),
  finishedAt: timestamp.optional(),
  breachedAt: timestamp.optional(),
  breachValue: z.number().optional(),
  note: z.string().optional(),
});
export type Verification = z.infer<typeof verificationSchema>;

export const incidentSchema = z.object({
  id: z.string(),
  title: z.string(),
  service: z.string(),
  severity: z.enum(["sev1", "sev2", "sev3", "sev4"]),
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
    // The watch rule that opened it, in words. Missing on incidents a person
    // opened and on those from before watch rules.
    rule: z.object({ id: z.string(), name: z.string(), description: z.string() }).optional(),
    // The route the rule tripped on ("/api/products"). Missing with the rule,
    // and on watch incidents from before it was recorded (it's in the title).
    route: z.string().optional(),
    // The time range (and route) a person selected on the live page to
    // investigate. Missing on every other incident.
    focus: z.object({ from: timestamp, to: timestamp, route: z.string().optional() }).optional(),
  }),
  steps: z.array(investigationStepSchema),
  // The model's thinking, one entry per model call, in order. Missing on
  // incidents from before it was recorded.
  thoughts: z.array(thoughtSchema).optional(),
  evidence: z.array(evidenceSchema),
  report: investigationReportSchema.optional(),
  mitigation: mitigationSchema.optional(),
  fix: fixSchema.optional(),
  validation: z.array(sandboxRunSchema).optional(),
  fixRun: fixRunSchema.optional(),
  approval: approvalSchema.optional(),
  run: runSchema.optional(),
  // Follow-up questions, in the order asked.
  questions: z.array(questionSchema).optional(),
  // Fixes denied with feedback, oldest first; the current one is `fix`.
  fixAttempts: z.array(fixAttemptSchema).optional(),
  // The blameless postmortem, written on request; writing again replaces it.
  postmortem: postmortemSchema.optional(),
  // The quiet window after the last recovery; a new one replaces it.
  verification: verificationSchema.optional(),
  // When the incident was last resolved; cleared when it is reopened.
  resolvedAt: timestamp.optional(),
  // Every reopening, oldest first.
  reopenings: z.array(reopeningSchema).optional(),
});
export type Incident =z.infer<typeof incidentSchema>;

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

// Phrases that say there's no fault: a hypothesis that "the alert is a false
// positive" or "no ongoing issue" is a healthy verdict's rationale, not a
// root cause. Seen on a live run: the model concluded "no ongoing problem;
// alert is false positive due to idle traffic" yet filed it as root_cause,
// and the fix stage then fixed a bug the investigation had ruled out.
const noFault =
  /\b(false[- ]positive|no (ongoing|real|actual|current|underlying|genuine) (issue|problem|fault|incident|regression)|no (issue|problem|fault) (found|detected|exists)|nothing (is )?(wrong|broken)|not an? (real|actual|genuine) (issue|problem|incident)|idle traffic|metric is meaningless)\b/i;

export const saysNothingIsWrong = (h: Hypothesis) => noFault.test(`${h.title}\n${h.causalChain.rootCause.text}`);

// Rules the JSON schema cannot express; checked after the model responds.
export function reportProblems(report: InvestigationReport): string[] {
  const problems: string[] = [];
  const { hypotheses, verdict } = report;
  if (verdict.kind === "root_cause") {
    if (hypotheses.length < 3) problems.push("root_cause verdict needs at least 3 hypotheses");
    const chosen = hypotheses.find((h) => h.id === verdict.hypothesisId);
    if (!chosen) problems.push(`verdict cites unknown hypothesis ${verdict.hypothesisId}`);
    else if (chosen.status !== "leading") problems.push("verdict hypothesis must be leading");
    else if (saysNothingIsWrong(chosen)) {
      problems.push(
        `verdict hypothesis ${chosen.id} says nothing is wrong ("${chosen.title}"). A breach with no fault behind it (a false positive, a one-off slow request that recovered, idle traffic) is a healthy verdict: submit healthy, with that as its rationale. root_cause is for a fault in the system that caused the breach.`,
      );
    }
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
