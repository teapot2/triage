import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type ModelMessage,
  ToolLoopAgent,
  type ToolSet,
  type UIMessageStreamWriter,
} from "ai";
import { languageModel, modelOptions, reasoningKind } from "../../models/client";
import { stageModel, stageProblem } from "../../models/settings";
import { recordThoughts } from "../agent";
import { incidentBlock } from "../context";
import { QuestionRecorder } from "../recorder";
import type { Incident, Question } from "../schema";
import { sourceFor } from "../source-for";
import type { TelemetrySource } from "../source";
import { createInvestigationTools, forModel } from "../tools";
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

function instructions(mode: Question["mode"]): string {
  const tools =
    mode === "tools"
      ? `- Use the tools when the recorded evidence does not answer the question. Prefer evidence that could disprove a claim: to say why something was ruled out, say what was checked and what it showed.
- If the tools find nothing in the window, say so instead of guessing.
- db_diagnostics and read_source read the system as it is now, not at alert time: say "now" when you cite them.
- Every tool is read-only. If the question asks you to change something, point at the incident's mitigation or fix instead.`
      : `- You have no tools for this incident: answer from the recorded evidence below. If it does not answer the question, say what is missing instead of guessing.`;
  return `You are Triage, an SRE. You already investigated this incident and wrote the report below. A person on the team asks a follow-up question: answer it, nothing more.

Rules:
- Cite every factual claim with an evidence ID in square brackets, e.g. [ev_log_3]. Cite only IDs listed below or returned by a tool. Never invent one.
${tools}
- Under 150 words unless the person asks for detail. Plain sentences or short bullets, no headings.`;
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
  try {
    const stage = await stageModel("ask");
    recorder.update({ provider: stage.provider, model: stage.model });
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

    // As in the investigation: Meta's API only supports tool_choice "auto",
    // so the last step has no tools and must answer, and a run that stops
    // after tool calls without text is nudged once.
    const agent = new ToolLoopAgent({
      model: languageModel(stage),
      providerOptions: modelOptions(stage),
      ...recordThoughts(recorder, reasoningKind(stage.provider)),
      instructions: instructions(mode),
      tools,
      stopWhen: () => stepsUsed >= MAX_STEPS,
      prepareStep: () => {
        stepsUsed += 1;
        return stepsUsed >= MAX_STEPS ? { activeTools: [] } : {};
      },
    });

    const messages: ModelMessage[] = [{ role: "user", content: prompt(incident, recorder.question, source) }];
    let inputTokens = 0;
    let outputTokens = 0;
    let text = "";
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
      inputTokens += usage.inputTokens ?? 0;
      outputTokens += usage.outputTokens ?? 0;
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
      inputTokens,
      outputTokens,
    });
    if (!text) writer.write({ type: "error", errorText: recorder.question.error! });
    writer.write({ type: "finish" });
  } catch (err) {
    console.error("[triage] question failed", incident.id, recorder.question.id, err);
    const message = errorText(err);
    recorder.update({ status: "failed", error: message, answeredAt: new Date().toISOString() });
    if (!streamed) writer.write({ type: "error", errorText: message });
  } finally {
    recorder.dropUnfinishedThoughts();
    await recorder.flush();
  }
}
