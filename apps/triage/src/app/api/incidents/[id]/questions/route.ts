import { z } from "zod";
import { answerQuestion } from "@/lib/investigation/ask/agent";
import { saveQuestionImage } from "@/lib/investigation/ask/images";
import {
  askRefusal,
  DEFAULT_IMAGE_QUESTION,
  MAX_IMAGE_BYTES,
  MAX_QUESTION_CHARS,
  nextQuestionId,
  sniffImageType,
} from "@/lib/investigation/ask/rules";
import type { Incident, Question } from "@/lib/investigation/schema";
import { sourceKind } from "@/lib/investigation/source-kind";
import { getIncident, patchIncident } from "@/lib/investigation/store";
import { stageModel, stageProblem } from "@/lib/models/settings";
import { recordedEffort } from "@/lib/models/stages";

// The answer runs inside this request (it streams through the response),
// capped at 10 model steps; this bounds it.
export const maxDuration = 120;

const bodySchema = z.object({ text: z.string().trim().min(1).max(MAX_QUESTION_CHARS) });
const imageSizeSchema = z.coerce.number().int().positive().max(10_000);

class Refused extends Error {}

type Body = { text: string; image?: { bytes: Uint8Array; mediaType: string; width: number; height: number } };

// The question from either body: JSON { text }, or multipart/form-data with
// `text` and an `image` file (with its `width` and `height`), where the text
// may be empty and then asks DEFAULT_IMAGE_QUESTION. A Response when the
// body is refused.
async function readBody(req: Request): Promise<Body | Response> {
  if (!req.headers.get("content-type")?.startsWith("multipart/form-data")) {
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: `expected { text }, 1 to ${MAX_QUESTION_CHARS} characters` }, { status: 400 });
    }
    return parsed.data;
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("image");
  const typed = form?.get("text");
  const text = (typeof typed === "string" ? typed : "").trim();
  if (text.length > MAX_QUESTION_CHARS) {
    return Response.json({ error: `The question is over ${MAX_QUESTION_CHARS} characters.` }, { status: 400 });
  }
  if (!(file instanceof File)) {
    if (!text) return Response.json({ error: "expected text, an image, or both" }, { status: 400 });
    return { text };
  }
  if (file.size > MAX_IMAGE_BYTES) {
    const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
    return Response.json({ error: `The image is ${mb(file.size)}; the limit is ${mb(MAX_IMAGE_BYTES)}.` }, { status: 413 });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mediaType = sniffImageType(bytes);
  if (!mediaType) return Response.json({ error: "The image must be a PNG, JPEG, GIF or WebP." }, { status: 400 });
  const width = imageSizeSchema.safeParse(form?.get("width"));
  const height = imageSizeSchema.safeParse(form?.get("height"));
  if (!width.success || !height.success) {
    return Response.json({ error: "expected the image's width and height in pixels" }, { status: 400 });
  }
  return { text: text || DEFAULT_IMAGE_QUESTION, image: { bytes, mediaType, width: width.data, height: height.data } };
}

// Asks a follow-up question on a finished incident, with a screenshot if
// one is attached. Appends it (status answering) and answers with a UI
// message stream over SSE: tool calls and text as the model produces them.
// The question's ID is in x-question-id. The answer is saved on the
// incident as it goes and runs to the end even if the client goes away.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const body = await readBody(req);
  if (body instanceof Response) return body;

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
      const image = body.image && {
        mediaType: body.image.mediaType,
        width: body.image.width,
        height: body.image.height,
        bytes: body.image.bytes.byteLength,
      };
      question = {
        id: nextQuestionId(i),
        text: body.text,
        ...(image && { image }),
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
        reasoningEffort: recordedEffort(stage),
      };
      return { ...i, questions: [...(i.questions ?? []), question] };
    });
  } catch (err) {
    if (err instanceof Refused) return Response.json({ error: err.message }, { status: 409 });
    throw err;
  }

  // Saved before the answer starts, which reads it from disk. If it can't
  // be, the answer fails with that reason (the agent finds no file).
  if (body.image) {
    await saveQuestionImage(id, question!.id, body.image.bytes, body.image.mediaType).catch((err) =>
      console.error("[triage] question image not saved", id, question!.id, err),
    );
  }

  const result = await answerQuestion(incident, question!);
  // Not awaited: the answer keeps running if the tab closes mid-stream.
  void result.consumeStream();
  return result.toUIMessageStreamResponse({ headers: { "x-question-id": question!.id } });
}
