import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type LanguageModel,
  type ModelMessage,
  ToolLoopAgent,
  type ToolSet,
  type UIMessageStreamWriter,
  type UserContent,
} from "ai";
import {
  cacheKey,
  callSettings,
  isTransientFailure,
  languageModel,
  modelErrorText,
  modelOptions,
  reasoningKind,
  webSearchTools,
} from "../../models/client";
import { runBudget } from "../../models/policy";
import type { ProviderId } from "../../models/providers";
import { choiceModel, stageModel, stageProblem } from "../../models/settings";
import { recordedEffort } from "../../models/stages";
import { fuller, noTokens, onEachCall } from "../../models/usage";
import { recordThoughts } from "../agent";
import { runAgentLoop } from "../agent-loop";
import { incidentBlock } from "../context";
import type { Stage } from "../fanout/run";
import { QuestionRecorder } from "../recorder";
import type { Incident, Question } from "../schema";
import { sourceFor } from "../source-for";
import type { TelemetrySource } from "../source";
import { listIncidents } from "../store";
import { createInvestigationTools, forModel } from "../tools";
import { type PromptText, splitTokens, toolsText } from "./context-parts";
import {
  buildContext,
  bundleText,
  cachedContext,
  estimateTokens,
  FULL_CONTEXT_MODEL,
  FULL_CONTEXT_TOKENS,
  type FullContext,
} from "./full-context";
import { readQuestionImage } from "./images";
import {
  answerOf,
  citedPages,
  countSearches,
  recordPages,
  searchSummary,
  WEB_SEARCH,
  WEB_SEARCH_RULES,
  withWebCitations,
} from "../web-search";
import { conversationHistory, knownEvidenceIds, parseCitations } from "./rules";

// Stage "ask": a follow-up question on a finished incident, answered by a
// small, bounded investigation with the same read-only tools, cited like
// the report. It streams to the asking tab as a UI message stream and is
// saved on the incident as it goes, so it doesn't depend on that tab.

const MAX_STEPS = 10;
// Times a run that stops after tool calls without an answer is told to
// answer.
const MAX_NUDGES = 1;
const NUDGE = "You have not answered yet. Answer the question now, citing evidence IDs in square brackets.";
// Earlier questions and answers given as context.
const HISTORY = 6;

// Only when the question carries a screenshot: what it shows is the
// person's, not evidence, so it's said in words and checked against the
// evidence rather than cited.
const IMAGE_RULES = `
- The person attached a screenshot. Read what it shows (the service, the time range, the values) before answering.
- Say in words what comes from the screenshot, e.g. "the screenshot shows p95 at 2.4 s from 14:05". Never cite it with an evidence ID: it isn't evidence.
- Check what it shows against the evidence and cite those IDs. If its service, times or numbers don't match the incident, say so plainly.
- If you can't read it (blurry, cropped, not a chart or an error), say what you can't make out.`;

function instructions(mode: Question["mode"], image: boolean, web: boolean): string {
  const tools =
    mode === "tools"
      ? `- Use the tools only when the question is about the system and the recorded evidence does not answer it. Prefer evidence that could disprove a claim: to say why something was ruled out, say what was checked and what it showed.
- If the tools find nothing in the window, say so instead of guessing.
- db_diagnostics and read_source read the system as it is now, not at alert time: say "now" when you cite them.
- Every tool is read-only. If the question asks you to change something, point at the incident's mitigation or fix instead.`
      : mode === "full_context"
        ? `- Everything Triage holds on this service is in the message, before this incident's report: its source code, its git history with every diff, its deploys, every earlier incident's report, and its telemetry up to the alert. You have no tools: answer from that material and the recorded evidence.
- Each item there has an ID (ev_ctx_source_…, ev_ctx_commit_…, ev_ctx_incident_…, ev_ctx_log_…, ev_ctx_span_…, ev_ctx_metric_…): cite those like evidence. Name an earlier incident or a commit only with its ID cited.
- Look across all of it: an earlier incident with the same signature, the change that introduced a line, a pattern that started before the alert window.
- If the material does not answer the question, say what is missing instead of guessing.`
        : `- You have no tools to read this incident's system: answer from the recorded evidence below. If it does not answer the question, say what is missing instead of guessing.`;
  const where = mode === "full_context" ? "in the message" : "below or returned by a tool";
  return `You are Triage, an SRE. Triage watches the team's services, opens an incident when an alert crosses its limit, investigates it, and proposes a mitigation and a fix for a person to approve. You already investigated this incident and wrote the report below. A person on the team, reading the incident's page, sends a message: answer it, nothing more.

Rules:
- Cite every claim about the system or the incident with an evidence ID in square brackets, e.g. [ev_log_3]. Cite only IDs listed ${where}. Never invent one. Questions about this conversation, the report, the incident's page or Triage itself need no citations.
${tools}${web ? WEB_SEARCH_RULES : ""}${image ? IMAGE_RULES : ""}
- A question about Triage or about something on the incident's page (a label, a status, a section) is on topic: answer it from the incident details below.
- Thanks, an acknowledgement or a reaction (frustration included) is not a question: reply in a sentence, plainly, without asking them to clarify.
- Only when you can't tell what the message means (stray keys, a fragment) say so in one sentence and ask what they mean. Don't investigate anything that isn't about the system.
- Answer each message on its own: don't repeat an earlier answer's wording.
- Match the length to the question: a sentence or two for a simple one, up to about 150 words otherwise, longer only if the person asks for detail.
- Answer in plain sentences. Use a short list only when the answer really is a list (steps, several separate causes). No headings.`;
}

// The question's prompt in its parts, which joined are the prompt; and of
// the earlier questions asked, how many the history carries.
function promptSections(incident: Incident, question: Question, source: TelemetrySource | undefined) {
  const earlier = (incident.questions ?? []).filter((q) => q.id !== question.id);
  const evidence = [...incident.evidence, ...earlier.flatMap((q) => q.evidence)]
    .map((e) => JSON.stringify(forModel(e)))
    .join("\n");
  const history = conversationHistory(earlier, HISTORY);
  const asked = earlier.filter((q) => q.status !== "answering").length;
  return {
    sections: {
      report: incidentBlock(incident, source),
      evidence: `\n\nEvidence you may cite:\n${evidence || "(none)"}\n`,
      history: history ? `\nEarlier questions:\n${history}\n` : "",
      question: `\nQuestion: ${question.text}`,
    },
    history: { included: Math.min(asked, HISTORY), asked },
  };
}

const NO_VISION_HINT = "(This model may not read images: pick a vision model for Ask in Settings.)";

// The answer as it runs: the route streams it to the asking tab, and
// consumeStream() resolves once it is answered (or failed) and saved. The
// answer runs to the end whether or not anyone reads the response.
export interface AnswerStream {
  consumeStream(): Promise<void>;
  toUIMessageStreamResponse(init?: { status?: number; headers?: HeadersInit }): Response;
}

// Tests: a model other than Settings' one, and a scripted model to call.
// `onToolCall` hears each tool the model calls, by name, as it calls it
// (the MCP server reports them as progress). `budget`: a full-context
// prompt's size in tokens, when not FULL_CONTEXT_TOKENS (a cheap probe);
// `others`: the earlier incidents, when not the store's.
type AnswerOptions = {
  stage?: Stage;
  languageModel?: LanguageModel;
  onToolCall?: (tool: string) => void;
  budget?: number;
  others?: Incident[];
};

// A full-context question's one step: reading the bundle.
const FULL_STEP = "full_context_1";
// One attempt, waited on longer: a prompt of several hundred thousand
// tokens takes a while to read, and a retry would bill it again.
const FULL_ATTEMPT_MS = 5 * 60_000;
const FULL_RUN_MS = 10 * 60_000;
// What the bundle leaves for the rest of the prompt: the instructions, this
// incident's report and evidence, earlier questions and the question. Fixed,
// so every question on the incident sends the same bundle.
const FULL_RESERVE = 100_000;

// Wonder on Meta's API, whatever Ask uses in Settings.
async function fullContextStage(): Promise<Stage> {
  const stage = await choiceModel("ask", FULL_CONTEXT_MODEL);
  if (!stage) throw new Error("Meta's API isn't available for a full-context answer.");
  return stage;
}

// The step's line: what the bundle held.
function bundleSummary(context: FullContext, tokens: number): string {
  const items = [...context.items.values()];
  const files = new Set(items.flatMap((e) => (e.kind === "source" ? [e.file] : []))).size;
  const commits = items.filter((e) => e.kind === "commit" && e.tool === "git_log").length;
  const incidents = items.filter((e) => e.kind === "incident").length;
  const back = context.spans.oldest ? `, spans back to ${context.spans.oldest.slice(11, 16)}` : "";
  return `Read about ${Math.round(tokens / 1000)}k tokens: ${files} files, ${commits} commits, ${incidents} earlier incidents, telemetry${back}`;
}

// Answers a question already appended to the incident (status answering).
// Never rejects: failures land on the question as status failed.
export async function answerQuestion(incident: Incident, question: Question, opts: AnswerOptions = {}): Promise<AnswerStream> {
  const recorder = new QuestionRecorder(structuredClone(question), incident.id, incident.service);
  let done: Promise<void> = Promise.resolve();
  const stream = createUIMessageStream({
    execute: ({ writer }) => (done = answer(incident, recorder, writer, opts)),
  });
  return {
    consumeStream: () => done,
    toUIMessageStreamResponse: (init = {}) => createUIMessageStreamResponse({ ...init, stream }),
  };
}

async function answer(
  incident: Incident,
  recorder: QuestionRecorder,
  writer: UIMessageStreamWriter,
  opts: AnswerOptions,
): Promise<void> {
  // An error the stream already carried to the tab, so it isn't sent twice.
  let streamed = false;
  let stepsUsed = 0;
  // Whether the model was called, so a failure before it isn't blamed on
  // the image.
  let calledModel = false;
  let provider: ProviderId | undefined;
  let retries = 0;
  // A full-context question reads the whole bundle in one call, no tools.
  const full = recorder.question.mode === "full_context";
  try {
    const stage = opts.stage ?? (full ? await fullContextStage() : await stageModel("ask"));
    provider = stage.provider;
    recorder.update({ provider: stage.provider, model: stage.model, reasoningEffort: recordedEffort(stage) });
    const problem = stageProblem(stage);
    if (problem) throw new Error(problem);

    // A live source that can't be read (files gone) answers from the
    // recorded evidence, like an incident without a source.
    const source = await sourceFor(incident).catch((err) => {
      console.error("[triage] question source unavailable", incident.id, err);
      return undefined;
    });
    if (full && !source) throw new Error("This incident's telemetry can't be read, so there's nothing to answer with full context.");
    const mode: Question["mode"] = full ? "full_context" : source ? "tools" : "evidence_only";
    recorder.update({ mode });
    const tools: ToolSet = full
      ? {}
      : {
          ...(source && createInvestigationTools(source, recorder, { submit: false })),
          ...webSearchTools(stage, recorder.question.webSearch === true),
        };
    const web = WEB_SEARCH in tools;

    // The screenshot goes with this question only, after its text; the
    // provider client turns the part into input_image or image_url.
    const question = recorder.question;
    const image = await readQuestionImage(incident.id, question);
    if (question.image && !image) throw new Error("The attached image couldn't be read back: ask again with it");
    const { sections, history } = promptSections(incident, question, source);
    // The bundle goes first, so the prompt's start is the same for every
    // question on the incident and Meta serves it from the cache.
    let bundle: FullContext | undefined;
    if (full) {
      recorder.startStep(FULL_STEP, "full_context", {});
      const room = (opts.budget ?? FULL_CONTEXT_TOKENS) - FULL_RESERVE;
      bundle = await cachedContext(incident.id, room, async () =>
        buildContext(incident, source!, opts.others ?? (await listIncidents({ service: incident.service })), room),
      );
      recorder.completeStep(FULL_STEP, "full_context", bundleSummary(bundle, estimateTokens(bundleText(bundle.parts))), []);
    }
    const prompt = (bundle ? bundleText(bundle.parts) : "") + Object.values(sections).join("");
    const content: UserContent = image
      ? [
          { type: "text", text: prompt },
          { type: "file", mediaType: image.mediaType, data: image.bytes },
        ]
      : prompt;
    const system = instructions(mode, image !== undefined, web);
    const promptText: PromptText = { instructions: system, tools: await toolsText(tools), ...sections, ...bundle?.parts };
    const maxSteps = full ? 1 : MAX_STEPS;

    // As in the investigation: Meta's API only supports tool_choice "auto",
    // so the last step has no tools and must answer, and a run that stops
    // after tool calls without text is nudged once.
    const agent = new ToolLoopAgent({
      model:
        opts.languageModel ??
        languageModel(stage, { onRetry: () => retries++, ...(full && { policy: { attempts: 1, attemptMs: FULL_ATTEMPT_MS } }) }),
      providerOptions: modelOptions(stage, cacheKey("ask", incident.id)),
      ...callSettings({ stream: true }),
      ...(full && { timeout: { chunkMs: FULL_ATTEMPT_MS } }),
      ...recordThoughts(recorder, reasoningKind(stage.provider)),
      ...onEachCall((call) =>
        recorder.update({
          context: fuller(recorder.question.context, call),
          // The first call is what the question started from.
          start: recorder.question.start ?? {
            inputTokens: call.inputTokens,
            parts: splitTokens(call.inputTokens, promptText, image !== undefined),
            history,
          },
        }),
      ),
      instructions: system,
      tools,
      stopWhen: () => stepsUsed >= maxSteps,
      prepareStep: () => {
        stepsUsed += 1;
        return stepsUsed >= maxSteps ? { activeTools: [] } : {};
      },
    });

    const messages: ModelMessage[] = [{ role: "user", content }];
    const tokens = noTokens();
    let text = "";
    let webSearches = 0;
    calledModel = true;
    const budget = runBudget("ask", full ? FULL_RUN_MS : undefined);
    await runAgentLoop({
      agent,
      messages,
      abortSignal: budget,
      steps: () => stepsUsed,
      maxSteps,
      maxNudges: full ? 0 : MAX_NUDGES,
      nudge: NUDGE,
      done: () => text !== "",
      tokens,
      // Streamed to the tab as it comes. A run that answers, or stops
      // without calling tools, isn't nudged.
      read: async (result, pass) => {
        let failure: unknown;
        let aborted: Error | undefined;
        let madeToolCalls = false;
        let stepToolCalls = false;
        const chunks = result.toUIMessageStream({
          sendStart: pass === 0,
          sendFinish: false,
          onError: (err) => {
            failure ??= err;
            return modelErrorText(err, stage.provider);
          },
        });
        for await (const chunk of chunks) {
          // A stream the budget or the stall limit cut off ends in an abort,
          // not an error: it fails the question like one, and the tab hears
          // why from the catch below.
          if (chunk.type === "abort") {
            aborted = new Error(chunk.reason ?? "The answer was cut off.");
            break;
          }
          writer.write(chunk);
          if (chunk.type === "text-delta") recorder.appendAnswer(chunk.delta);
          else if (chunk.type === "tool-input-start" && chunk.toolName === WEB_SEARCH) {
            // Meta searches inside the model call, so the step goes on: the
            // text before it was the model saying what it'll look up.
            recorder.startStep(chunk.toolCallId, WEB_SEARCH, {});
            madeToolCalls = true;
            if (recorder.question.answer) recorder.update({ answer: "" });
          } else if (chunk.type === "tool-output-available" && chunk.providerExecuted) {
            recorder.completeStep(chunk.toolCallId, WEB_SEARCH, searchSummary(chunk.output), []);
          } else if (chunk.type === "tool-output-error" && chunk.providerExecuted) {
            recorder.failStep(chunk.toolCallId, chunk.errorText);
          } else if (chunk.type === "tool-input-start" || chunk.type === "tool-input-available") {
            stepToolCalls = madeToolCalls = true;
            if (chunk.type === "tool-input-available") opts.onToolCall?.(chunk.toolName);
          } else if (chunk.type === "finish-step") {
            // Text written alongside tool calls is the model thinking aloud
            // (kept as a thought), not the answer.
            if (stepToolCalls && recorder.question.answer) recorder.update({ answer: "" });
            stepToolCalls = false;
          }
        }
        if (failure) {
          streamed = true;
          throw failure;
        }
        if (aborted) throw budget.aborted ? budget.reason : aborted;
        const steps = await result.steps;
        webSearches += countSearches(steps);
        // The pages the answer cites become its evidence, their IDs put in
        // where Meta marked the words they back.
        const answer = answerOf(steps.at(-1)?.content ?? []);
        text = withWebCitations(answer.text, answer.citations, recordPages(recorder, citedPages(answer.citations))).trim();
        return text !== "" || !madeToolCalls;
      },
    });

    // Of the bundle, only what the answer cites is kept, on the step; an
    // item an earlier question already keeps is cited from there.
    if (bundle) {
      const known = knownEvidenceIds(incident, recorder.question);
      const cited = parseCitations(text, new Set(bundle.items.keys())).citedIds.filter((id) => !known.has(id));
      recorder.attachEvidence(FULL_STEP, cited.map((id) => bundle.items.get(id)!));
    }
    const { citedIds, unknownIds } = parseCitations(text, knownEvidenceIds(incident, recorder.question));
    recorder.update({
      status: text ? "answered" : "failed",
      error: text ? undefined : `No answer after ${stepsUsed} model steps`,
      answer: text,
      citedIds,
      unknownIds,
      answeredAt: new Date().toISOString(),
      modelRetries: retries,
      ...(webSearches && { webSearches }),
      ...tokens,
    });
    if (!text) writer.write({ type: "error", errorText: recorder.question.error! });
    writer.write({ type: "finish" });
  } catch (err) {
    console.error("[triage] question failed", incident.id, recorder.question.id, err);
    // A model that can't see refuses the image with its own wording, which
    // Triage can't tell apart from other errors: with an image attached,
    // the likely cause is said too, unless the API or the clock failed.
    const text = modelErrorText(err, provider);
    const message = recorder.question.image && calledModel && !isTransientFailure(err) ? `${text} ${NO_VISION_HINT}` : text;
    if (recorder.question.steps.some((s) => s.id === FULL_STEP && s.status === "running")) recorder.failStep(FULL_STEP, message);
    recorder.update({
      status: "failed",
      error: message,
      answeredAt: new Date().toISOString(),
      modelRetries: retries,
    });
    if (!streamed) writer.write({ type: "error", errorText: message });
  } finally {
    recorder.dropUnfinishedThoughts();
    await recorder.flush();
  }
}
