import { type LanguageModel, type ModelMessage, parsePartialJson, tool, ToolLoopAgent } from "ai";
import { z } from "zod";
import { cacheKey, callSettings, languageModel, modelErrorText, modelOptions } from "../../models/client";
import { runBudget } from "../../models/policy";
import type { ProviderId } from "../../models/providers";
import { readTemplate, runStageModel, stageProblem } from "../../models/settings";
import { fuller, noTokens, onEachCall, type TokenCounts } from "../../models/usage";
import { runAgentLoop } from "../agent-loop";
import { knownEvidenceIds } from "../ask/rules";
import { gradeHypothesis, gradeLabels } from "../confidence-grade";
import { cite, incidentBlock } from "../context";
import type { Stage } from "../fanout/run";
import { dataChangeOf } from "../fix/data-change";
import { rollupLabels, type VerdictOutcome, verdictOutcome } from "../outcome";
import { evidenceId, type Incident, type Postmortem, type PostmortemDraft, postmortemSchema } from "../schema";
import { getIncident, patchIncident } from "../store";
import { forModel } from "../tools";
import { draftContent, nextAttempt, writingSection } from "./draft";
import { endDraft, publishDraft } from "./live";
import { citedEvidenceIds, MAX_FACTORS, MIN_FACTORS, type PostmortemSubmission, postmortemProblems } from "./rules";
import { type BuiltInSection, customSections, keptBuiltIns, type Template } from "./template";
import { postmortemTimeline } from "./timeline";

// Stage "postmortem": the blameless postmortem's judgment (summary, impact,
// contributing factors, what went well and badly, luck, action items),
// written by one model over the incident's record. No tools but the one it
// submits with, which checks the submission like submit_report does and
// hands the problems back. Runs after the route's response. The submission
// streams: the page follows it as a draft (draft.ts), live through
// live.ts and saved on the record about once a second.

const MAX_STEPS = 3;
// Times a run that stops with plain text, without an accepted submission,
// is told to submit.
const MAX_NUDGES = 1;
const NUDGE = "You have not submitted an accepted postmortem yet. Fix any problems listed, then call submit_postmortem.";

// The writer's rules for each built-in section the template can keep. The
// timeline has none: the renderer builds it.
const sectionRules: Partial<Record<BuiltInSection, string>> = {
  summary: "- summary: three plain sentences, under 80 words, on what happened, the impact and how long it lasted. No evidence IDs.",
  impact: "- impact: who was affected and how.",
  outcome:
    "- verdictReview: one or two sentences on whether the first diagnosis held, judged only from the Outcome block below: name what confirmed or contradicted it, cite the evidence IDs that block gives. If nothing checked it, say it stands unverified. Never call it confirmed because a fix was written or merged; only a recovered mitigation, a proven regression test or a completed verification confirms it.",
  factors: `- contributingFactors: ${MIN_FACTORS} to ${MAX_FACTORS} conditions that each had to hold for the incident to happen, where the evidence supports them: the code path, the input that triggered it, capacity (a pool size, a limit), detection (an alert that was missing or late). When the alert fired on a symptom (latency, errors) and nothing watched the resource that actually ran out (a pool, a queue, a disk), that missing alert is a contributing factor in its own right, cited to the metric evidence that shows the resource saturating.`,
  lessons:
    "- wentWell and wentBadly judge detection, response and tooling, never the symptoms themselves: what caught the problem or missed it (an alert on latency but none on the pool), what made the response faster or slower (a flag made the mitigation quick; no test covered the failing path), what tooling helped or was missing. A symptom belongs in impact or the factors, not here.",
  lucky: "- lucky: what could have made it worse and did not.",
  actions:
    "- actionItems: mix the four kinds (fix_this, prevent_class, detect_sooner, mitigate_faster), with a priority each. Never repeat the fix (\"merge the PR\", \"approve the fix\", or the fix's own words) or the mitigation's steps: both are covered separately. fix_this items are what this instance still needs beyond the fix and the mitigation; if nothing is left, give fewer items rather than restating them.",
};

// The system prompt: the general rules, then the rules of the sections the
// template keeps, then its custom sections.
export function instructionsFor(template: Template): string {
  const kept = keptBuiltIns(template);
  const custom = customSections(template);
  const lines = [
    "You are Triage, an SRE. Write the team's blameless postmortem for the incident below, from its record.",
    "",
    "Rules:",
    `- Blameless: ask how the system allowed the failure, never who caused it. A deploy "shipped", a flag "was turned on"; nobody is named. Avoid "blame", "fault of", "should have", "failed to", "careless" and "negligent": say what the system did or did not do.`,
    "- Cite every factual claim: put the evidence IDs it rests on in that claim's evidenceIds, plain (ev_log_3, not [ev_log_3]). Cite only IDs listed below. Never invent one.",
    "- Say only what the record shows. A mitigation that was proposed but not applied did not happen. When no recovery is recorded, do not guess how or when the impact ended: an incident marked resolved was resolved without a recorded recovery time; otherwise the record does not show when the impact ended.",
    ...kept.flatMap((key) => sectionRules[key] ?? []),
  ];
  if (custom.length) {
    lines.push(
      "",
      "Custom sections your team asks for. Write each into `custom` under its id, with the same rules: cite evidence IDs, stay blameless, and say that the record does not show it rather than invent it.",
      ...custom.map((c) => `- ${c.id} (${c.name}): ${c.instructions}`),
    );
  }
  lines.push(
    "",
    "- Under 400 words in all.",
    "- Write submit_postmortem's fields in the order the tool lists them: the document's order.",
    "- Submit with submit_postmortem. If it is rejected, fix the listed problems and submit again.");
  return lines.join("\n");
}

// The record fields each built-in section is written into.
const sectionFields: Partial<Record<BuiltInSection, (keyof Postmortem)[]>> = {
  summary: ["summary"],
  impact: ["impact"],
  outcome: ["verdictReview"],
  factors: ["contributingFactors"],
  lessons: ["wentWell", "wentBadly"],
  lucky: ["lucky"],
  actions: ["actionItems"],
};

// The tool's input: the judgment of the sections the template keeps, every
// field required, plus the custom sections' texts when it has any. Its
// fields in the template's order, where the custom list stands in for the
// first custom section: models write them as listed, so the document fills
// in from the top.
export function submissionSchemaFor(template: Template) {
  const fields = template.sections.flatMap((s) => (s.kind === "builtin" ? (sectionFields[s.key] ?? []) : ["custom" as const]));
  const order = [...new Set(fields)];
  const mask = Object.fromEntries(order.filter((f) => f !== "custom").map((f) => [f, true as const]));
  // pick() wants a literal mask; this one is built from the template.
  const base = (postmortemSchema.pick(mask as never) as unknown as typeof postmortemSchema).required();
  const custom = customSections(template);
  const ids = custom.map((c) => c.id) as [string, ...string[]];
  const shape: Record<string, z.ZodType> = {
    ...(base.shape as Record<string, z.ZodType>),
    ...(custom.length ? { custom: z.array(z.object({ id: z.enum(ids), text: z.string(), evidenceIds: z.array(evidenceId) })) } : {}),
  };
  return z.object(Object.fromEntries(order.map((f) => [f, shape[f]]))) as unknown as z.ZodType<PostmortemSubmission>;
}

// The incident's times in order, as a timeline the model can quote: the
// postmortem's own (timeline.ts), so the verification window and any
// reopening are in it, as they are in the document.
function timelineBlock(incident: Incident): string {
  const lines = postmortemTimeline(incident).map((e) => `${e.at} ${e.event}`);
  if (!incident.mitigation?.recovery?.recoveredAt) {
    lines.push(
      incident.status === "resolved"
        ? "The incident is marked resolved, but no recovery time is recorded."
        : "No recovery is recorded: the record does not show when the impact ended.",
    );
  }
  return lines.join("\n");
}

function mitigationBlock(incident: Incident): string {
  const m = incident.mitigation;
  if (!m) return "None proposed.";
  const lines = [
    `${m.title} (${m.kind} of ${m.target}, risk ${m.risk}): ${m.state}`,
    `Why: ${cite(m.why)}`,
    `Steps: ${m.steps.join("; ")}`,
    `Undo: ${m.undo}`,
  ];
  if (m.error) lines.push(`Error: ${m.error}`);
  if (m.recovery) {
    const r = m.recovery;
    lines.push(`Recovery: ${r.status} (${r.metric} under ${r.threshold})${r.note ? `, ${r.note}` : ""}`);
  }
  return lines.join("\n");
}

function fixBlock(incident: Incident): string {
  const { fix, fixRun, validation } = incident;
  if (!fix) return fixRun?.declinedBecause ? `Declined: ${fixRun.declinedBecause}` : fixRun ? `No fix (${fixRun.status}).` : "None written.";
  const lines = [
    fix.summary,
    `Files: ${fix.files.join(", ")}; risk ${fix.risk}${dataChangeOf(fix).detected ? "; touches data" : ""}`,
    `Regression test: ${fix.regressionTest.name} (${fix.regressionTest.file})`,
  ];
  for (const run of validation ?? []) {
    const failed = run.tests.filter((t) => t.status === "failed").length;
    lines.push(`Sandbox, ${run.label}: exit ${run.exitCode}, ${run.tests.length - failed} passed, ${failed} failed${run.repro ? `; ${run.repro.request} -> ${run.repro.status} in ${run.repro.latencyMs} ms` : ""}`);
  }
  if (fixRun) {
    const rejections = fixRun.rejections?.length ? `, rejected: ${fixRun.rejections.join("; ")}` : "";
    lines.push(`Fix stage: ${fixRun.status} after ${fixRun.attempt} attempts${rejections}`);
  }
  return lines.join("\n");
}

// The approval, without who decided it: the postmortem names nobody.
function approvalBlock(incident: Incident): string {
  const a = incident.approval;
  if (!a) return "None requested.";
  const pr = a.prState ? `; PR ${a.prState}${a.prUrl ? ` ${a.prUrl}` : ""}` : "";
  return `${a.state}${a.reason ? `, reason: ${a.reason}` : ""}${pr}`;
}

// Whether the diagnosis held, as the record shows it (outcome.ts): the
// hypothesis with its grade, the roll-up, then each signal with its status
// and time. The model only puts this in a sentence; it never decides it.
function outcomeBlock(incident: Incident, outcome: VerdictOutcome | undefined): string {
  if (!outcome) return "Nothing has checked the diagnosis yet.";
  const h = outcome.hypothesis;
  const hypothesis = incident.report?.hypotheses.find((x) => x.id === h.id);
  const reason = hypothesis ? gradeHypothesis(hypothesis, incident).reason : "";
  const cited = hypothesis
    ? [...new Set([hypothesis.causalChain.symptom, hypothesis.causalChain.propagation, hypothesis.causalChain.rootCause].flatMap((c) => c.evidenceIds))]
    : [];
  const lines = [
    `Diagnosis: ${h.id} "${h.title}", confidence ${h.confidence}, ${gradeLabels[h.grade].toLowerCase()}${reason ? ` (${reason})` : ""}`,
    ...(cited.length ? [`Its evidence: ${cited.join(", ")}`] : []),
    `Result: ${rollupLabels[outcome.rollup].toLowerCase()}`,
    ...outcome.signals.map((sig) => `- ${sig.at ?? "(no time recorded)"} ${sig.status} (${sig.kind}): ${sig.text}`),
  ];
  if (outcome.signals.length === 0) lines.push("Nothing has checked the diagnosis yet.");
  return lines.join("\n");
}

function prompt(incident: Incident, outcome: VerdictOutcome | undefined): string {
  const evidence = [...incident.evidence, ...(incident.questions ?? []).flatMap((q) => q.evidence)]
    .map((e) => JSON.stringify(forModel(e)))
    .join("\n");
  return `${incidentBlock(incident, undefined)}

Timeline:
${timelineBlock(incident)}

Mitigation:
${mitigationBlock(incident)}

Fix:
${fixBlock(incident)}

Approval:
${approvalBlock(incident)}

Outcome:
${outcomeBlock(incident, outcome)}

Evidence you may cite:
${evidence || "(none)"}

Write the postmortem and submit it.`;
}

// What the tool says it checks, for the sections the template keeps.
export function submitDescription(template: Template): string {
  const kept = new Set(keptBuiltIns(template));
  const checks = [
    ...(kept.has("factors") ? [`${MIN_FACTORS} to ${MAX_FACTORS} contributing factors`] : []),
    ...(kept.has("outcome") ? ["the verdict review matches the recorded outcome"] : []),
    ...(customSections(template).length ? ["every custom section written once"] : []),
    "every cited evidence ID must exist",
    "nobody named or blamed",
    ...(kept.has("actions") ? ["no action item repeating the fix"] : []),
  ];
  return `Submit the postmortem. It is checked: ${checks.join(", ")}. If it is rejected, fix the listed problems and submit again.`;
}

// The submitted custom sections with the names the template gives them.
function namedCustom(custom: NonNullable<PostmortemSubmission["custom"]>, template: Template): NonNullable<Postmortem["custom"]> {
  const names = new Map(customSections(template).map((c) => [c.id, c.name]));
  return custom.map((c) => ({ ...c, name: names.get(c.id) ?? c.id }));
}

// Saves the draft on the record at most this often while it streams: a
// reload, or a tab on another server, reads along from there.
const SAVE_EVERY_MS = 1000;
// The end of the model's latest paragraph of reasoning the draft keeps.
const THOUGHT_CHARS = 240;

// The submission as it streams: parsed as each piece arrives, published to
// the page and saved now and then. A second submit_postmortem call (after a
// rejection) starts the next attempt from empty.
class DraftStream {
  draft: PostmortemDraft = nextAttempt(undefined);
  private callId: string | undefined;
  private raw = "";
  private thoughts = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastSave = 0;
  private saving: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly incidentId: string,
    private readonly startedAt: string,
    private readonly known: Set<string>,
    private readonly template: Template,
  ) {}

  // Tells the page the write is under way, before anything is written.
  announce() {
    publishDraft(this.incidentId, { startedAt: this.startedAt, draft: this.draft });
  }

  begin(callId: string) {
    if (this.callId !== undefined) this.draft = nextAttempt(this.draft, this.draft.problems);
    this.callId = callId;
    this.raw = "";
    this.changed();
  }

  async append(callId: string, delta: string) {
    if (callId !== this.callId) return;
    this.raw += delta;
    await this.parse();
  }

  // The whole input, for a provider that doesn't stream it.
  async whole(callId: string, input: unknown) {
    if (callId === this.callId && this.raw) return;
    if (callId !== this.callId) this.begin(callId);
    this.raw = JSON.stringify(input);
    await this.parse();
  }

  // The model's reasoning as it streams: the end of its latest paragraph,
  // from a word's start, for the page to show while nothing is written yet.
  // Each summary part (reasoning-start) is a paragraph of its own.
  think(delta: string, part = false) {
    this.thoughts += part ? "\n\n" : delta;
    const paragraph = this.thoughts
      .split(/\n\s*\n/)
      .findLast((p) => p.trim())
      ?.trim()
      .replace(/\s+/g, " ");
    if (!paragraph) return;
    const latest = paragraph.length > THOUGHT_CHARS ? `…${paragraph.slice(-THOUGHT_CHARS).replace(/^\S*\s/, "")}` : paragraph;
    if (latest === this.draft.thinking) return;
    this.draft = { ...this.draft, thinking: latest };
    this.changed();
  }

  reject(problems: string[]) {
    this.draft = { ...this.draft, problems };
    this.changed();
  }

  // Stops saving, once the last save is in. The record's finish follows.
  async close() {
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.saving;
  }

  private async parse() {
    const { value, state } = await parsePartialJson(this.raw);
    this.draft = {
      ...this.draft,
      // None open once the JSON is whole.
      writing: state === "successful-parse" ? undefined : (writingSection(value) ?? this.draft.writing),
      content: draftContent(value, this.known, this.template),
    };
    this.changed();
  }

  private changed() {
    publishDraft(this.incidentId, { startedAt: this.startedAt, draft: this.draft });
    if (this.timer) return;
    this.timer = setTimeout(() => this.save(), Math.max(0, this.lastSave + SAVE_EVERY_MS - Date.now()));
  }

  private save() {
    this.timer = undefined;
    this.lastSave = Date.now();
    const draft = this.draft;
    this.saving = this.saving
      .then(() =>
        patchIncident(this.incidentId, (i) =>
          i.postmortem?.status === "writing" && i.postmortem.startedAt === this.startedAt
            ? { ...i, postmortem: { ...i.postmortem, draft } }
            : i,
        ),
      )
      .catch((err) => console.error("[triage] saving the postmortem draft failed", this.incidentId, err));
  }
}

// Writes the postmortem of an incident whose record is status writing (the
// route saves it so). Never throws: failures land on the record, with the
// draft as far as it got. `opts` is for tests: a model other than
// Settings' one, and a scripted model to call.
export async function writePostmortem(
  incidentId: string,
  opts: { stage?: Stage; languageModel?: LanguageModel } = {},
): Promise<void> {
  const finish = (startedAt: string, patch: Partial<Postmortem>) =>
    patchIncident(incidentId, (i) =>
      i.postmortem?.status === "writing" && i.postmortem.startedAt === startedAt
        ? { ...i, postmortem: { ...i.postmortem, ...patch, finishedAt: new Date().toISOString() } }
        : i,
    );

  const tokens = noTokens();
  // The fullest call; three at most, so saved with the rest at the end.
  let context: TokenCounts | undefined;
  let startedAt: string | undefined;
  let provider: ProviderId | undefined;
  let retries = 0;
  let stream: DraftStream | undefined;
  // What a failure keeps: the draft, when anything was written.
  const partial = () => {
    const draft = stream?.draft;
    return draft && Object.keys(draft.content).length ? draft : undefined;
  };
  try {
    const incident = await getIncident(incidentId);
    if (incident?.postmortem?.status !== "writing") return;
    const started = (startedAt = incident.postmortem.startedAt);
    // The template the route saved on the record (the one in settings for a
    // record from before it did).
    const template = incident.postmortem.template ?? (await readTemplate());
    const live = (stream = new DraftStream(incidentId, started, knownEvidenceIds(incident), template));
    live.announce();
    await patchIncident(incidentId, (i) =>
      i.postmortem?.status === "writing" && i.postmortem.startedAt === started
        ? { ...i, postmortem: { ...i.postmortem, template, draft: live.draft } }
        : i,
    );
    const stage = opts.stage ?? (await runStageModel("postmortem", incident.models?.postmortem));
    provider = stage.provider;
    const problem = stageProblem(stage);
    if (problem) throw new Error(problem);
    const submissionSchema = submissionSchemaFor(template);
    // Worked out once, from the record as it was when the write began: the
    // prompt shows it and the checks hold the review to it.
    const outcome = verdictOutcome(incident);

    let accepted: PostmortemSubmission | undefined;
    let lastProblems: string[] = [];
    let stepsUsed = 0;
    const agent = new ToolLoopAgent({
      model: opts.languageModel ?? languageModel(stage, { onRetry: () => retries++ }),
      providerOptions: modelOptions(stage, cacheKey("postmortem", incidentId)),
      ...callSettings({ stream: true }),
      ...onEachCall((call) => (context = fuller(context, call))),
      instructions: instructionsFor(template),
      tools: {
        submit_postmortem: tool({
          description: submitDescription(template),
          inputSchema: submissionSchema,
          execute: async (input) => {
            const submission = submissionSchema.parse(input);
            lastProblems = postmortemProblems(submission, incident, template, outcome);
            if (lastProblems.length > 0) {
              live.reject(lastProblems);
              return `Rejected:\n${lastProblems.map((p) => `- ${p}`).join("\n")}`;
            }
            accepted = submission;
            return "Accepted.";
          },
        }),
      },
      stopWhen: [() => stepsUsed >= MAX_STEPS, () => accepted !== undefined],
      prepareStep: () => {
        stepsUsed += 1;
        return {};
      },
    });

    const messages: ModelMessage[] = [{ role: "user", content: prompt(incident, outcome) }];
    const budget = runBudget("postmortem");
    await runAgentLoop({
      agent,
      messages,
      abortSignal: budget,
      steps: () => stepsUsed,
      maxSteps: MAX_STEPS,
      maxNudges: MAX_NUDGES,
      nudge: NUDGE,
      done: () => accepted !== undefined,
      tokens,
      // The submission streams into the draft as it's written.
      read: async (result) => {
        for await (const part of result.fullStream) {
          switch (part.type) {
            case "reasoning-start":
              live.think("", true);
              break;
            case "reasoning-delta":
              live.think(part.text);
              break;
            case "tool-input-start":
              if (part.toolName === "submit_postmortem") live.begin(part.id);
              break;
            case "tool-input-delta":
              await live.append(part.id, part.delta);
              break;
            case "tool-call":
              if (part.toolName === "submit_postmortem") await live.whole(part.toolCallId, part.input);
              break;
            case "tool-error":
              // A submission whose fields aren't in the tool's shape never
              // reaches its checks; the model is told and submits again.
              if (part.toolName === "submit_postmortem") live.reject(["a field wasn't in the shape the form asks for"]);
              break;
            case "error":
              throw part.error;
            // Cut off by the budget or the stall limit: fails like an error.
            case "abort":
              throw budget.aborted ? budget.reason : new Error(part.reason ?? "The postmortem was cut off.");
          }
        }
      },
    });

    await live.close();
    if (accepted) {
      await finish(started, {
        ...accepted,
        custom: accepted.custom && customSections(template).length ? namedCustom(accepted.custom, template) : undefined,
        template,
        draft: undefined,
        status: "ready",
        error: undefined,
        citedIds: citedEvidenceIds(accepted),
        unknownIds: [],
        modelRetries: retries,
        ...tokens,
        context,
      });
    } else {
      const error = lastProblems.length
        ? `Rejected: ${lastProblems.join("; ")}`
        : `No postmortem submitted after ${stepsUsed} model steps`;
      await finish(started, {
        status: "failed",
        error: error.slice(0, 1000),
        draft: partial(),
        modelRetries: retries,
        ...tokens,
        context,
      });
    }
  } catch (err) {
    console.error("[triage] postmortem failed", incidentId, err);
    await stream?.close();
    if (startedAt) {
      await finish(startedAt, {
        status: "failed",
        error: modelErrorText(err, provider),
        draft: partial(),
        modelRetries: retries,
        ...tokens,
        context,
      }).catch(
        (saveErr) => console.error("[triage] saving the failed postmortem failed", incidentId, saveErr),
      );
    }
  } finally {
    if (startedAt) endDraft(incidentId, startedAt);
  }
}
