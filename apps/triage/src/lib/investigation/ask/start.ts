import { choiceModel, stageModel, stageProblem, webSearchOn } from "../../models/settings";
import { FULL_CONTEXT_MODEL } from "./full-context";
import { recordedEffort } from "../../models/stages";
import type { Incident, Question } from "../schema";
import { archivedRefusal, isArchived } from "../archive";
import { sourceKind } from "../source-kind";
import { getIncident, patchIncident } from "../store";
import { saveQuestionImage } from "./images";
import { askRefusal, nextQuestionId } from "./rules";

// Starting a question, shared by the Ask route and the MCP server: checks
// the incident and the Ask stage, then appends the question (status
// answering) under the incident's lock. answerQuestion() answers it.

export type QuestionImage = { bytes: Uint8Array; mediaType: string; width: number; height: number };

export type StartedQuestion =
  | { ok: true; incident: Incident; question: Question }
  | { ok: false; status: 404 | 409; error: string };

class Refused extends Error {}

export async function startQuestion(
  id: string,
  text: string,
  opts: { image?: QuestionImage; webSearch?: boolean; fullContext?: boolean; via?: Question["via"] } = {},
): Promise<StartedQuestion> {
  const found = await getIncident(id);
  if (!found) return { ok: false, status: 404, error: `unknown incident: ${id}` };
  // Before the model's checks, so an archived incident says why first.
  if (isArchived(found)) return { ok: false, status: 409, error: archivedRefusal };
  // A full-context question runs on Wonder whatever Ask uses, over the
  // incident's own telemetry: one without a source has nothing to read.
  const full = opts.fullContext === true;
  if (full && !sourceKind(found)) {
    return { ok: false, status: 409, error: "This incident has no telemetry to read: ask without full context." };
  }
  const stage = full ? await choiceModel("ask", FULL_CONTEXT_MODEL) : await stageModel("ask");
  const problem = stage ? stageProblem(stage) : "Meta's API isn't available.";
  if (!stage || problem) return { ok: false, status: 409, error: problem! };
  // Only Meta's API has the search; elsewhere the question is asked without.
  // Without a choice, Settings decides. A full-context answer has no tools.
  const webSearch = !full && stage.provider === "meta" && (opts.webSearch ?? (await webSearchOn()));

  let question: Question | undefined;
  let incident: Incident;
  try {
    // Checked and appended under the incident's lock, so two quick asks
    // can't both start a question.
    incident = await patchIncident(id, (i) => {
      const refusal = isArchived(i) ? archivedRefusal : askRefusal(i);
      if (refusal) throw new Refused(refusal);
      const image = opts.image && {
        mediaType: opts.image.mediaType,
        width: opts.image.width,
        height: opts.image.height,
        bytes: opts.image.bytes.byteLength,
      };
      question = {
        id: nextQuestionId(i),
        text,
        ...(image && { image }),
        ...(opts.via && { via: opts.via }),
        askedAt: new Date().toISOString(),
        status: "answering",
        answer: "",
        citedIds: [],
        unknownIds: [],
        steps: [],
        evidence: [],
        mode: full ? "full_context" : sourceKind(i) ? "tools" : "evidence_only",
        webSearch,
        provider: stage.provider,
        model: stage.model,
        reasoningEffort: recordedEffort(stage),
      };
      return { ...i, questions: [...(i.questions ?? []), question] };
    });
  } catch (err) {
    if (err instanceof Refused) return { ok: false, status: 409, error: err.message };
    throw err;
  }

  // Saved before the answer starts, which reads it from disk. If it can't
  // be, the answer fails with that reason (the agent finds no file).
  if (opts.image) {
    await saveQuestionImage(id, question!.id, opts.image.bytes, opts.image.mediaType).catch((err) =>
      console.error("[triage] question image not saved", id, question!.id, err),
    );
  }
  return { ok: true, incident, question: question! };
}
