import { z } from "zod";
import { answerQuestion } from "@/lib/investigation/ask/agent";
import { askRefusal, MAX_QUESTION_CHARS, nextQuestionId } from "@/lib/investigation/ask/rules";
import type { Incident, Question } from "@/lib/investigation/schema";
import { sourceKind } from "@/lib/investigation/source-for";
import { getIncident, patchIncident } from "@/lib/investigation/store";
import { stageModel, stageProblem } from "@/lib/models/settings";

// The answer runs inside this request (it streams through the response),
// capped at 10 model steps; this bounds it.
export const maxDuration = 120;

const bodySchema = z.object({ text: z.string().trim().min(1).max(MAX_QUESTION_CHARS) });

class Refused extends Error {}

// Asks a follow-up question on a finished incident. Appends it (status
// answering) and answers with a UI message stream over SSE: tool calls and
// text as the model produces them. The question's ID is in x-question-id.
// The answer is saved on the incident as it goes and runs to the end even
// if the client goes away.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: `expected { text }, 1 to ${MAX_QUESTION_CHARS} characters` }, { status: 400 });
  }

  const { id } = await params;
  if (!(await getIncident(id))) return Response.json({ error: `unknown incident: ${id}` }, { status: 404 });
  const stage = await stageModel("ask");
  const problem = stageProblem(stage);
  if (problem) return Response.json({ error: problem }, { status: 409 });

  let question: Question | undefined;
  let incident: Incident;
  try {
    // Checked and appended under the incident's lock, so two quick POSTs
    // can't both start a question.
    incident = await patchIncident(id, (i) => {
      const refusal = askRefusal(i);
      if (refusal) throw new Refused(refusal);
      question = {
        id: nextQuestionId(i),
        text: parsed.data.text,
        askedAt: new Date().toISOString(),
        status: "answering",
        answer: "",
        citedIds: [],
        unknownIds: [],
        steps: [],
        evidence: [],
        mode: sourceKind(i) ? "tools" : "evidence_only",
        provider: stage.provider,
        model: stage.model,
      };
      return { ...i, questions: [...(i.questions ?? []), question] };
    });
  } catch (err) {
    if (err instanceof Refused) return Response.json({ error: err.message }, { status: 409 });
    throw err;
  }

  const result = await answerQuestion(incident, question!);
  // Not awaited: the answer keeps running if the tab closes mid-stream.
  void result.consumeStream();
  return result.toUIMessageStreamResponse({ headers: { "x-question-id": question!.id } });
}
