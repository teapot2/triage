import { z } from "zod";
import { reasoningEffortSchema } from "../models/stages";
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
  // Meta's built-in search, run on its side (Fix and Ask only).
  "web_search",
  // A dependency incident's exposure stage (dependencies/exposure.ts): the
  // audit's advisory as the run's first step, then listing and searching
  // the service's source.
  "dependency_audit",
  "list_files",
  "grep_source",
  // A full-context question (ask/full-context.ts): the one step that read
  // the whole bundle into the prompt, holding what the answer cited.
  "full_context",
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
    // From deploy_history only: what the record was (a deploy, a config
    // change, a rollback) and the branch it was deployed from. The mitigation
    // proposer reads both; older records have neither.
    deployKind: z.enum(["deploy", "config", "rollback"]).optional(),
    branch: z.string().optional(),
  }),
  // A page the model cited after searching the web: the URL is all Meta
  // returns of it, with the page's title when it has one.
  z.object({
    ...evidenceBase,
    kind: z.literal("web"),
    url: z.url(),
    title: z.string().optional(),
  }),
  // An earlier incident a full-context answer cited: its report was in the
  // prompt (ask/full-context.ts), and the page links to it.
  z.object({
    ...evidenceBase,
    kind: z.literal("incident"),
    incidentId: z.string(),
    title: z.string(),
    verdict: z.string().optional(),
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
  // The model call that asked for it: its thought's ID. Calls from one model
  // call share it and ran at the same time. Kept when the thought itself is
  // dropped for being empty. Missing on runs recorded before Oct 31 and on
  // stages that record no thoughts.
  turn: z.string().optional(),
  // Which part of a fan-out investigation ran it: "scout", a hypothesis's
  // lane ("h1" to "h3") or "merge". Missing on single-agent runs.
  lane: z.string().optional(),
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
  // As on steps: the fan-out lane that made this model call.
  lane: z.string().optional(),
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

// On a dependency incident (dependencies/exposure.ts): whether the service's
// code reaches the vulnerable package. reachable: the service imports it, or
// a direct dependency it calls uses the vulnerable part. transitive_only: it
// is in the tree, but nothing found leads from the service's code to it.
// not_reachable: the code that would use it never runs in production.
// The rationale cites the importing files (source evidence).
export const exposureVerdicts = ["reachable", "transitive_only", "not_reachable"] as const;
export const exposureSchema = z.object({
  verdict: z.enum(exposureVerdicts),
  rationale: claimSchema,
});
export type Exposure = z.infer<typeof exposureSchema>;

// What the model returns as structured output at the end of Stage 2.
// `summary` is optional here only so reports saved before it existed still
// load; submit_report requires it.
export const investigationReportSchema = z.object({
  summary: reportSummarySchema.optional(),
  hypotheses: z.array(hypothesisSchema),
  verdict: verdictSchema,
  servicesQueried: z.array(z.string()),
  // Dependency incidents only.
  exposure: exposureSchema.optional(),
});
export type InvestigationReport = z.infer<typeof investigationReportSchema>;

// Whether a fix changes stored data, worked out from its edits when it was
// proven (fix/data-change.ts). Approving one needs a person to say they
// reviewed the data change. Fixes saved before it existed lack it; read it
// through dataChangeOf, which works it out from the patch for them.
export const dataChangeSchema = z.object({
  detected: z.boolean(),
  reasons: z.array(z.string()),
  // The files whose changes touch data.
  files: z.array(z.string()),
  // The SQL and migration files among them: the sandbox never runs them.
  unproven: z.array(z.string()),
});
export type DataChange = z.infer<typeof dataChangeSchema>;

export const fixSchema = z.object({
  summary: z.string(),
  patch: z.string().describe("Unified diff"),
  files: z.array(z.string()),
  regressionTest: z.object({ file: z.string(), name: z.string() }),
  risk: z.enum(["low", "medium", "high"]),
  // The model's own claim; dataChange is what Triage worked out.
  touchesData: z.boolean(),
  dataChange: dataChangeSchema.optional(),
  // The web pages the fix stage cited while writing it, as evidence on the
  // incident.
  sourceIds: z.array(z.string()).optional(),
  // A dependency incident's fix (dependencies/fix.ts): the package raised to
  // its patched version, as the service's own dependency (direct) or by a
  // package manager override (override); major when it crosses a major
  // version. Its regressionTest names the sandbox's re-audit.
  bump: z
    .object({
      package: z.string(),
      from: z.string(),
      to: z.string(),
      kind: z.enum(["direct", "override"]),
      major: z.boolean(),
    })
    .optional(),
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
  // A rollback's release branch, when the deploy record named one: the fix
  // PR targets it, since the fix was proven against that release's code.
  branch: z.string().optional(),
  title: z.string(),
  why: claimSchema,
  steps: z.array(z.string()),
  undo: z.string(),
  risk: z.enum(["very_low", "low", "medium"]),
  state: z.enum(["proposed", "approved", "denied", "running", "applied", "failed"]),
  proposedAt: timestamp,
  decidedAt: timestamp.optional(),
  // Who decided, by name, and their Slack member ID when they clicked a
  // button in Slack. Both missing when decided on the incident page.
  decidedBy: z.string().optional(),
  decidedInSlack: z.string().optional(),
  appliedAt: timestamp.optional(),
  output: z.string().optional(),
  error: z.string().optional(),
  recovery: recoverySchema.optional(),
});
export type Mitigation = z.infer<typeof mitigationSchema>;

// Why no mitigation stands beside a root-cause verdict, so the page says so
// rather than showing nothing: the diagnosis cites no flag flip or deploy to
// undo (the load itself, say), or only ones already undone.
export const noMitigationSchema = z.object({
  why: z.string(),
  at: timestamp,
});
export type NoMitigation = z.infer<typeof noMitigationSchema>;

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
  // The approver's Slack member ID, when they approved with a Slack button.
  decidedInSlack: z.string().optional(),
  reason: z.string().optional(),
  // Set when the fix changes stored data and the approver said they
  // reviewed that change.
  dataReviewed: z.boolean().optional(),
  // Stage 5, after an approval: opening the PR, then its URL or why it failed.
  prState: z.enum(["opening", "opened", "failed"]).optional(),
  prError: z.string().optional(),
  prUrl: z.url().optional(),
  // When the PR was merged, as the PR check last saw it.
  prMergedAt: timestamp.optional(),
});
export type Approval = z.infer<typeof approvalSchema>;

// One model call's tokens: a record's fullest call, by input, kept as its
// `context` (models/usage.ts fuller()) and shown against the model's
// context window. Absent until the record's first call finishes.
export const contextSchema = z.object({
  inputTokens: z.number().int(),
  cachedInputTokens: z.number().int(),
  outputTokens: z.number().int(),
  reasoningTokens: z.number().int(),
});

// Stages 3 and 4 as they run: the model writes a fix and a regression test,
// the sandbox proves them, and a failed proof goes back to the model.
export const fixRunSchema = z.object({
  // declined: the model judged the diagnosis isn't a code defect it should
  // fix (see declinedBecause), instead of fixing something else.
  status: z.enum(["writing", "testing", "proven", "failed", "declined"]),
  declinedBecause: z.string().optional(),
  attempt: z.number().int().describe("Submissions so far, counting the one being tested"),
  // The fix stage's provider, model and effort (Meta's API only).
  provider: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  rejections: z.array(z.string()).optional().describe("Why each rejected submission failed, first line only"),
  startedAt: timestamp,
  // As on the investigation's run: the fix stage's host waking up.
  wakingSince: timestamp.optional(),
  finishedAt: timestamp.optional(),
  modelSteps: z.number().int().optional(),
  inputTokens: z.number().int().optional(),
  // Of the input, served from Meta's prompt cache; of the output, reasoning.
  // Missing on records from before they were recorded.
  cachedInputTokens: z.number().int().optional(),
  outputTokens: z.number().int().optional(),
  reasoningTokens: z.number().int().optional(),
  // Model calls retried after a 429, 5xx, timeout or network error
  // (models/fetch.ts). Absent on records from before they were counted.
  modelRetries: z.number().int().optional(),
  // Web searches Meta ran for the stage, billed apart from tokens.
  webSearches: z.number().int().optional(),
  context: contextSchema.optional(),
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

// A fan-out investigation's hypotheses, each checked in its own lane, and
// the lead model that proposed and merged them.
export const fanoutSchema = z.object({
  leadProvider: z.string().optional(),
  leadModel: z.string(),
  leadReasoningEffort: reasoningEffortSchema.optional(),
  // The lead's own tokens (scout and merge), priced at its model's rates;
  // the run's token fields hold the lanes'. Missing on fan-outs from before
  // they were split, whose run fields hold every phase's.
  inputTokens: z.number().int().optional(),
  cachedInputTokens: z.number().int().optional(),
  outputTokens: z.number().int().optional(),
  reasoningTokens: z.number().int().optional(),
  // The lead's fullest call, scout or merge.
  context: contextSchema.optional(),
  hypotheses: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      claim: z.string(),
      finding: z.enum(["supported", "refuted", "unclear"]).optional(),
      reason: z.string().optional(),
      evidenceFor: z.array(evidenceId).default([]),
      evidenceAgainst: z.array(evidenceId).default([]),
      steps: z.number().int().optional(),
      // Its lane's fullest call, on the run's model.
      context: contextSchema.optional(),
      error: z.string().optional(),
    }),
  ),
});
export type Fanout = z.infer<typeof fanoutSchema>;

// How the investigation ran, for the UI and the benchmark.
export const runSchema = z.object({
  source: z.string().describe("Telemetry source, e.g. scenario:pool-leak"),
  // Where the investigate stage's model ran (see lib/models). Missing on
  // runs from before stages had their own models.
  provider: z.string().optional(),
  model: z.string(),
  // How hard it reasoned: Meta's API only, and missing on runs from before
  // efforts were set.
  reasoningEffort: reasoningEffortSchema.optional(),
  startedAt: timestamp,
  // Set while the model's host wakes from scaled to zero (Modal), before
  // the first model call; cleared once it answers.
  wakingSince: timestamp.optional(),
  finishedAt: timestamp.optional(),
  modelSteps: z.number().int().optional(),
  inputTokens: z.number().int().optional(),
  // Of the input, served from Meta's prompt cache; of the output, reasoning.
  // Missing on records from before they were recorded.
  cachedInputTokens: z.number().int().optional(),
  outputTokens: z.number().int().optional(),
  reasoningTokens: z.number().int().optional(),
  rejectedReports: z.number().int().optional(),
  // As on the fix run: model calls retried.
  modelRetries: z.number().int().optional(),
  // The fullest call of the stage's model: the single agent's, or across a
  // fan-out's lanes and its fallback.
  context: contextSchema.optional(),
  error: z.string().optional(),
  // Set on a fan-out investigation (lib/investigation/fanout).
  fanout: fanoutSchema.optional(),
});
export type Run = z.infer<typeof runSchema>;

// A question's prompt, part by part, in estimated tokens; `screenshot`
// only when one was attached, and the bundle's four parts only on a
// full-context question.
export const promptPartsSchema = z.object({
  instructions: z.number().int(),
  tools: z.number().int(),
  report: z.number().int(),
  evidence: z.number().int(),
  history: z.number().int(),
  question: z.number().int(),
  screenshot: z.number().int().optional(),
  source: z.number().int().optional(),
  changes: z.number().int().optional(),
  incidents: z.number().int().optional(),
  telemetry: z.number().int().optional(),
});
export type PromptParts = z.infer<typeof promptPartsSchema>;

export const questionStartSchema = z.object({
  inputTokens: z.number().int(),
  parts: promptPartsSchema,
  history: z.object({ included: z.number().int(), asked: z.number().int() }),
});
export type QuestionStart = z.infer<typeof questionStartSchema>;

// A follow-up question on a finished incident, answered by a small,
// bounded investigation with the same read-only tools. Its steps and
// evidence live on the question; evidence IDs carry the question's ID
// (ev_q2_span_1) so they never collide with the investigation's. `answer`
// grows while it streams; the citations are parsed from it at the end.
export const questionSchema = z.object({
  id: z.string().regex(/^q_\d+$/).describe("Sequential per incident; also the evidence ID prefix"),
  text: z.string().min(1).max(500),
  // A screenshot attached to the question, shrunk in the browser. The bytes
  // live beside the incident (ask/images.ts), not in this record.
  image: z
    .object({
      mediaType: z.string(),
      width: z.number().int(),
      height: z.number().int(),
      bytes: z.number().int(),
    })
    .optional(),
  // Asked from a coding agent through Triage's MCP server (lib/mcp), not
  // from the incident's page. Missing on questions asked on the page.
  via: z.enum(["mcp"]).optional(),
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
  // answer comes from the recorded evidence without tools. full_context: one
  // Wonder call over everything Triage holds on the service, no tools
  // (ask/full-context.ts).
  mode: z.enum(["tools", "evidence_only", "full_context"]),
  // Whether the answer may search the web: the composer's switch, on Meta's
  // API only. Missing on questions from before it existed (off).
  webSearch: z.boolean().optional(),
  webSearches: z.number().int().optional(),
  provider: z.string().optional(),
  model: z.string(),
  reasoningEffort: reasoningEffortSchema.optional(),
  inputTokens: z.number().int().optional(),
  // Of the input, served from Meta's prompt cache; of the output, reasoning.
  // Missing on records from before they were recorded.
  cachedInputTokens: z.number().int().optional(),
  outputTokens: z.number().int().optional(),
  reasoningTokens: z.number().int().optional(),
  modelRetries: z.number().int().optional(),
  context: contextSchema.optional(),
  // What the question started from: its first model call's input, split
  // roughly by what filled it (ask/context-parts.ts), and how many earlier
  // questions it carried of those asked. The Ask composer shows the
  // latest one's. Missing on records from before it was recorded.
  start: questionStartSchema.optional(),
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

// A claim as the model writes it: the text so far, and the evidence IDs it
// has finished citing.
const draftClaimSchema = z.object({ text: z.string(), evidenceIds: z.array(evidenceId) });

// The postmortem while the model writes it (postmortem/draft.ts): its
// submission so far, every field possibly cut short. `writing` is the
// template section whose field is still open, absent once the submission
// is whole; `attempt` counts submissions, from 1, and `problems` is why the
// last one was rejected.
// `thinking` is the end of the model's latest paragraph of reasoning.
export const postmortemDraftSchema = z.object({
  attempt: z.number().int(),
  writing: z.string().optional(),
  thinking: z.string().optional(),
  problems: z.array(z.string()).optional(),
  content: z.object({
    summary: z.string().optional(),
    impact: draftClaimSchema.optional(),
    contributingFactors: z.array(draftClaimSchema).optional(),
    wentWell: z.array(draftClaimSchema).optional(),
    wentBadly: z.array(draftClaimSchema).optional(),
    lucky: z.array(z.string()).optional(),
    verdictReview: draftClaimSchema.optional(),
    actionItems: z
      .array(
        z.object({
          title: z.string(),
          kind: postmortemActionItemSchema.shape.kind.optional(),
          priority: postmortemActionItemSchema.shape.priority.optional(),
          evidenceIds: z.array(evidenceId).optional(),
        }),
      )
      .optional(),
    custom: z.array(z.object({ id: z.string(), text: z.string(), evidenceIds: z.array(evidenceId) })).optional(),
  }),
});
export type PostmortemDraft = z.infer<typeof postmortemDraftSchema>;
export type DraftContent = PostmortemDraft["content"];

// The blameless postmortem's judgment, written by one model call over the
// recorded evidence (postmortem/writer.ts). Everything else in the
// document (impact numbers, timeline, fix, evidence appendix) is rendered
// from the incident itself. One record; writing again replaces it. The
// content fields are absent while it is being written or after a failure:
// `draft` holds what is written so far, and where a failed write stopped.
export const postmortemSchema = z.object({
  status: z.enum(["writing", "ready", "failed"]),
  startedAt: timestamp,
  finishedAt: timestamp.optional(),
  error: z.string().optional(),
  provider: z.string().optional(),
  model: z.string(),
  reasoningEffort: reasoningEffortSchema.optional(),
  inputTokens: z.number().int().optional(),
  // Of the input, served from Meta's prompt cache; of the output, reasoning.
  // Missing on records from before they were recorded.
  cachedInputTokens: z.number().int().optional(),
  outputTokens: z.number().int().optional(),
  reasoningTokens: z.number().int().optional(),
  modelRetries: z.number().int().optional(),
  context: contextSchema.optional(),
  summary: z.string().optional().describe("Three sentences, under 80 words: what happened, impact, duration. No evidence IDs."),
  impact: claimSchema.optional().describe("Who was affected and how, cited"),
  contributingFactors: z.array(claimSchema).optional().describe("2 to 5 conditions that each had to hold, cited"),
  wentWell: z.array(claimSchema).optional(),
  wentBadly: z.array(claimSchema).optional(),
  lucky: z.array(z.string()).optional().describe("What could have made it worse"),
  actionItems: z.array(postmortemActionItemSchema).optional(),
  // Absent on records from before the outcome section: it renders from the
  // incident without it.
  verdictReview: claimSchema
    .optional()
    .describe("One or two sentences on whether the first diagnosis held, judged only from the Outcome block, cited"),
  // The template's custom sections as written, named as the template named them.
  custom: z.array(z.object({ id: z.string(), name: z.string(), text: z.string(), evidenceIds: z.array(evidenceId) })).optional(),
  // The template this was written with, kept so it renders in the same shape
  // later. Absent on records from before templates: they are the default.
  template: templateSchema.optional(),
  draft: postmortemDraftSchema.optional(),
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
// After an uptime check's healthy run, the window is that run: its samples'
// response times, already judged, so the record is written resolved.
// After a dependency fix's PR is merged ("dependencies"), the audit loop
// verifies: the first audit that no longer finds the advisory resolves it;
// each one that still does is a point on the series (1) and a note.
export const verificationSchema = z.object({
  after: z.enum(["mitigation", "fix", "manual", "uptime", "dependencies"]),
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

// The uptime check behind an incident it opened, and how its episode is
// going: failing checks so far, the latest, and when a run of healthy ones
// confirmed recovery while the investigation was still running (it
// resolves once there is a report).
export const uptimeEpisodeSchema = z.object({
  checkId: z.string(),
  rule: z.enum(["slow", "down"]),
  failedChecks: z.number().int().nonnegative(),
  lastFailedAt: timestamp.optional(),
  recoveredAt: timestamp.optional(),
});
export type UptimeEpisode = z.infer<typeof uptimeEpisodeSchema>;

// The advisory behind an incident the dependency audit opened
// (dependencies/), as the latest audit that found it saw it: the package,
// the versions the service's tree holds, the range that fixes it, and the
// chains from the service's own dependencies down to it. audits counts the
// audits that found it while the incident was open; goneAt is when one
// first didn't.
export const dependencyAdvisorySchema = z.object({
  advisoryId: z.string(),
  package: z.string(),
  title: z.string(),
  versions: z.array(z.string()).min(1),
  vulnerable: z.string(),
  patched: z.string().optional(),
  severity: z.enum(["info", "low", "moderate", "high", "critical"]),
  cwe: z.array(z.string()),
  url: z.string(),
  dev: z.boolean(),
  direct: z.array(z.string()),
  paths: z.array(z.string()),
  audits: z.number().int().nonnegative(),
  lastFoundAt: timestamp,
  goneAt: timestamp.optional(),
});
export type DependencyAdvisory = z.infer<typeof dependencyAdvisorySchema>;

// A stage's model as a run was asked to use it, safe for the browser
// (models/settings.ts checks the provider when a re-run starts).
export const stageChoiceSchema = z.object({
  provider: z.string(),
  model: z.string().trim().min(1).max(200),
  effort: reasoningEffortSchema.optional(),
});
export type StageChoice = z.infer<typeof stageChoiceSchema>;

// The models a re-run was started with. `lead` only when it checks its
// hypotheses in parallel; `fix` and `postmortem` go with the run, so the fix
// written after a deny and a postmortem written once it's promoted use them.
export const runModelsSchema = z.object({
  investigate: stageChoiceSchema,
  lead: stageChoiceSchema.optional(),
  fix: stageChoiceSchema.optional(),
  postmortem: stageChoiceSchema.optional(),
});
export type RunModels = z.infer<typeof runModelsSchema>;

// What a live investigation read that can't be read again later: the
// database checks, run once as it started, and the Shopfront source as it
// stood (saved beside the incident, live/run-snapshot.ts), with the commit
// git_log reads history from. A re-run reads these instead of the present.
export const runSnapshotSchema = z.object({
  takenAt: timestamp,
  gitFrom: z.string().optional(),
});
export type RunSnapshot = z.infer<typeof runSnapshotSchema>;

const incidentBaseSchema = z.object({
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
    // An SLO rule's: how fast its error budget was burning when it tripped,
    // the burn rate its alert fires at over its long and short windows, and
    // what was left of the budget. Missing on every other incident.
    burn: z
      .object({
        rate: z.number(),
        threshold: z.number(),
        longMs: z.number(),
        shortMs: z.number(),
        budgetLeftPercent: z.number(),
      })
      .optional(),
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
  noMitigation: noMitigationSchema.optional(),
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
  // The uptime check that opened it. Missing on every other incident.
  uptime: uptimeEpisodeSchema.optional(),
  // The advisory the dependency audit opened it for. Missing on every other
  // incident.
  dependency: dependencyAdvisorySchema.optional(),
  // The models a re-run was started with, on a run that was one (now or
  // before it was promoted). Missing on a first run: its records say.
  models: runModelsSchema.optional(),
  // The incident's first Slack message, posted through the Slack bot: later
  // events reply in its thread and it is updated with the incident's status.
  // Missing when no bot was set up when the incident opened.
  slack: z.object({ channel: z.string(), ts: z.string() }).optional(),
  // When it was archived (investigation/archive.ts): hidden from the lists
  // and read-only until restored. Missing on an active incident.
  archivedAt: timestamp.optional(),
});

// The fields that make one investigation run: the investigation itself and
// what came of it (mitigation, fix, postmortem). A re-run has its own; the
// incident's (its alert, questions, verification, resolution) are shared.
export const runFields = [
  "status",
  "steps",
  "thoughts",
  "evidence",
  "report",
  "mitigation",
  "noMitigation",
  "fix",
  "validation",
  "fixRun",
  "approval",
  "fixAttempts",
  "run",
  "postmortem",
  "models",
] as const;

// Another run of the incident's investigation on the same telemetry, with
// other models: a re-run, or the first run after a re-run was promoted over
// it. Numbered in the order started, the first run being 1.
export const rerunSchema = incidentBaseSchema
  .pick(Object.fromEntries(runFields.map((f) => [f, true])) as { [K in (typeof runFields)[number]]: true })
  .extend({ number: z.number().int().min(1) });
export type Rerun = z.infer<typeof rerunSchema>;

export const incidentSchema = incidentBaseSchema.extend({
  // Which run the incident's own fields hold. Missing: 1, the first.
  runNumber: z.number().int().min(1).optional(),
  // The incident's other runs, in the order started.
  reruns: z.array(rerunSchema).optional(),
  // A live run's snapshot, for re-runs. Missing on every other incident,
  // and on live ones from before snapshots.
  snapshot: runSnapshotSchema.optional(),
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

// Phrases that say there's no fault: a hypothesis that "the alert is a false
// positive" or "no ongoing issue" is a healthy verdict's rationale, not a
// root cause. Seen on a live run: the model concluded "no ongoing problem;
// alert is false positive due to idle traffic" yet filed it as root_cause,
// and the fix stage then fixed a bug the investigation had ruled out.
const noFault =
  /\b(false[- ]positive|no (ongoing|real|actual|current|underlying|genuine) (issue|problem|fault|incident|regression)|no (issue|problem|fault) (found|detected|exists)|nothing (is )?(wrong|broken)|not an? (real|actual|genuine) (issue|problem|incident)|idle traffic|metric is meaningless)\b/i;

export const saysNothingIsWrong = (h: Hypothesis) => noFault.test(`${h.title}\n${h.causalChain.rootCause.text}`);

// Text that stands in for an answer instead of giving one. Seen on a Spark
// run: hypotheses titled t1-t3 with claims s1, p1, r1 and rej2, each citing
// real evidence, so only the summary said anything.
const placeholder = /^(?:[a-z_]{0,4}\d+|todo|tbd|n\/?a|none|placeholder|\.+|-+|\?+)$/i;
const isPlaceholder = (text: string) => text.trim() === "" || placeholder.test(text.trim());
// A claim is a statement: one word can't say what happened.
const saysTooLittle = (text: string) => isPlaceholder(text) || text.trim().split(/\s+/).length < 2;

function placeholderFields(h: Hypothesis): string[] {
  const claims: [string, Claim | undefined][] = [
    ["symptom", h.causalChain.symptom],
    ["propagation", h.causalChain.propagation],
    ["rootCause", h.causalChain.rootCause],
    ["rejectedBecause", h.rejectedBecause],
  ];
  return [
    ...(isPlaceholder(h.title) ? [`title "${h.title}"`] : []),
    ...claims.flatMap(([name, c]) => (c && saysTooLittle(c.text) ? [`${name} "${c.text}"`] : [])),
  ];
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
    const blank = placeholderFields(h);
    if (blank.length) {
      problems.push(
        `hypothesis ${h.id} has placeholders instead of findings: ${blank.join(", ")}. Write the title as the cause in a few words and each claim as a sentence saying what the cited evidence shows.`,
      );
    }
  }
  const ids = hypotheses.map((h) => h.id);
  if (new Set(ids).size !== ids.length) problems.push("hypothesis ids must be unique");
  return problems;
}
