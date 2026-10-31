import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type ModelMessage,
  ToolLoopAgent,
  type ToolSet,
  type UIMessageStreamWriter,
  type UserContent,
} from "ai";
import { cacheKey, languageModel, modelOptions, reasoningKind } from "../../models/client";
import { stageModel, stageProblem } from "../../models/settings";
import { recordedEffort } from "../../models/stages";
import { addUsage, noTokens } from "../../models/usage";
import { recordThoughts } from "../agent";
import { incidentBlock } from "../context";
import { QuestionRecorder } from "../recorder";
import type { Incident, Question } from "../schema";
import { sourceFor } from "../source-for";
import type { TelemetrySource } from "../source";
import { createInvestigationTools, forModel } from "../tools";
import { readQuestionImage } from "./images";
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

function instructions(mode: Question["mode"], image: boolean): string {
  const tools =
    mode === "tools"
      ? `- Use the tools only when the question is about the system and the recorded evidence does not answer it. Prefer evidence that could disprove a claim: to say why something was ruled out, say what was checked and what it showed.
- If the tools find nothing in the window, say so instead of guessing.
- db_diagnostics and read_source read the system as it is now, not at alert time: say "now" when you cite them.
- Every tool is read-only. If the question asks you to change something, point at the incident's mitigation or fix instead.`
      : `- You have no tools for this incident: answer from the recorded evidence below. If it does not answer the question, say what is missing instead of guessing.`;
  return `You are Triage, an SRE. Triage watches the team's services, opens an incident when an alert crosses its limit, investigates it, and proposes a mitigation and a fix for a person to approve. You already investigated this incident and wrote the report below. A person on the team, reading the incident's page, sends a message: answer it, nothing more.

Rules:
- Cite every claim about the system or the incident with an evidence ID in square brackets, e.g. [ev_log_3]. Cite only IDs listed below or returned by a tool. Never invent one. Questions about this conversation, the report, the incident's page or Triage itself need no citations.
${tools}${image ? IMAGE_RULES : ""}
- A question about Triage or about something on the incident's page (a label, a status, a section) is on topic: answer it from the incident details below.
- Thanks, an acknowledgement or a reaction (frustration included) is not a question: reply in a sentence, plainly, without asking them to clarify.
- Only when you can't tell what the message means (stray keys, a fragment) say so in one sentence and ask what they mean. Don't investigate anything that isn't about the system.
- Answer each message on its own: don't repeat an earlier answer's wording.
- Match the length to the question: a sentence or two for a simple one, up to about 150 words otherwise, longer only if the person asks for detail.
- Answer in plain sentences. Use a short list only when the answer really is a list (steps, several separate causes). No headings.`;
}

function prompt(incident: Incident, question: Question, source: TelemetrySource | undefined): string {
  const earlier = (incident.questions ?? []).filter((q) => q.id !== question.id);
  const evidence = [...incident.evidence, ...earlier.flatMap((q) => q.evidence)]
    .map((e) => JSON.stringify(forModel(e)))
    .join("\n");
  const history = conversationHistory(earlier, HISTORY);
  return `${incidentBlock(incident, source)}

Evidence you may cite:
${evidence || "(none)"}
${history ? `\nEarlier questions:\n${history}\n` : ""}
Question: ${question.text}`;
}

const NO_VISION_HINT = "(This model may not read images: pick a vision model for Ask in Settings.)";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 500);

// The answer as it runs: the route streams it to the asking tab, and
// consumeStream() resolves once it is answered (or failed) and saved. The
// answer runs to the end whether or not anyone reads the response.
export interface AnswerStream {
  consumeStream(): Promise<void>;
  toUIMessageStreamResponse(init?: { status?: number; headers?: HeadersInit }): Response;
}

// Answers a question already appended to the incident (status answering).
// Never rejects: failures land on the question as status failed.
export async function answerQuestion(incident: Incident, question: Question): Promise<AnswerStream> {
  const recorder = new QuestionRecorder(structuredClone(question), incident.id, incident.service);
  let done: Promise<void> = Promise.resolve();
  const stream = createUIMessageStream({
    execute: ({ writer }) => (done = answer(incident, recorder, writer)),
  });
  return {
    consumeStream: () => done,
    toUIMessageStreamResponse: (init = {}) => createUIMessageStreamResponse({ ...init, stream }),
  };
}

async function answer(incident: Incident, recorder: QuestionRecorder, writer: UIMessageStreamWriter): Promise<void> {
  // An error the stream already carried to the tab, so it isn't sent twice.
  let streamed = false;
  let stepsUsed = 0;
  // Whether the model was called, so a failure before it isn't blamed on
  // the image.
  let calledModel = false;
  try {
    const stage = await stageModel("ask");
    recorder.update({ provider: stage.provider, model: stage.model, reasoningEffort: recordedEffort(stage) });
    const problem = stageProblem(stage);
    if (problem) throw new Error(problem);

    // A live source that can't be read (files gone) answers from the
    // recorded evidence, like an incident without a source.
    const source = await sourceFor(incident).catch((err) => {
      console.error("[triage] question source unavailable", incident.id, err);
      return undefined;
    });
    const mode: Question["mode"] = source ? "tools" : "evidence_only";
    recorder.update({ mode });
    const tools: ToolSet = source ? createInvestigationTools(source, recorder, { submit: false }) : {};

    // The screenshot goes with this question only, after its text; the
    // provider client turns the part into input_image or image_url.
    const question = recorder.question;
    const image = await readQuestionImage(incident.id, question);
    if (question.image && !image) throw new Error("The attached image couldn't be read back: ask again with it");
    const content: UserContent = image
      ? [
          { type: "text", text: prompt(incident, question, source) },
          { type: "file", mediaType: image.mediaType, data: image.bytes },
        ]
      : prompt(incident, question, source);

    // As in the investigation: Meta's API only supports tool_choice "auto",
    // so the last step has no tools and must answer, and a run that stops
    // after tool calls without text is nudged once.
    const agent = new ToolLoopAgent({
      model: languageModel(stage),
      providerOptions: modelOptions(stage, cacheKey("ask", incident.id)),
      ...recordThoughts(recorder, reasoningKind(stage.provider)),
      instructions: instructions(mode, image !== undefined),
      tools,
      stopWhen: () => stepsUsed >= MAX_STEPS,
      prepareStep: () => {
        stepsUsed += 1;
        return stepsUsed >= MAX_STEPS ? { activeTools: [] } : {};
      },
    });

    const messages: ModelMessage[] = [{ role: "user", content }];
    const tokens = noTokens();
    let text = "";
    calledModel = true;
    for (let pass = 0; pass <= MAX_NUDGES && stepsUsed < MAX_STEPS; pass++) {
      if (pass > 0) messages.push({ role: "user", content: NUDGE });
      const result = await agent.stream({ messages });
      let failure: unknown;
      let madeToolCalls = false;
      let stepToolCalls = false;
      const chunks = result.toUIMessageStream({
        sendStart: pass === 0,
        sendFinish: false,
        onError: (err) => {
          failure ??= err;
          return errorText(err);
        },
      });
      for await (const chunk of chunks) {
        writer.write(chunk);
        if (chunk.type === "text-delta") recorder.appendAnswer(chunk.delta);
        else if (chunk.type === "tool-input-start" || chunk.type === "tool-input-available") {
          stepToolCalls = madeToolCalls = true;
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
      const usage = await result.totalUsage;
      addUsage(tokens, usage);
      messages.push(...(await result.responseMessages));
      text = (await result.steps).at(-1)?.text.trim() ?? "";
      if (text || !madeToolCalls) break;
    }

    const { citedIds, unknownIds } = parseCitations(text, knownEvidenceIds(incident, recorder.question));
    recorder.update({
      status: text ? "answered" : "failed",
      error: text ? undefined : `No answer after ${stepsUsed} model steps`,
      answer: text,
      citedIds,
      unknownIds,
      answeredAt: new Date().toISOString(),
      ...tokens,
    });
    if (!text) writer.write({ type: "error", errorText: recorder.question.error! });
    writer.write({ type: "finish" });
  } catch (err) {
    console.error("[triage] question failed", incident.id, recorder.question.id, err);
    // A model that can't see refuses the image with its own wording, which
    // Triage can't tell apart from other errors: with an image attached,
    // the likely cause is said too.
    const message = recorder.question.image && calledModel ? `${errorText(err)} ${NO_VISION_HINT}` : errorText(err);
    recorder.update({ status: "failed", error: message, answeredAt: new Date().toISOString() });
    if (!streamed) writer.write({ type: "error", errorText: message });
  } finally {
    recorder.dropUnfinishedThoughts();
    await recorder.flush();
  }
}
