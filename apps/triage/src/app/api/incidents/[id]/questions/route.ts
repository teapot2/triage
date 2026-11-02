import { z } from "zod";
import { answerQuestion } from "@/lib/investigation/ask/agent";
import { DEFAULT_IMAGE_QUESTION, MAX_IMAGE_BYTES, MAX_QUESTION_CHARS, sniffImageType } from "@/lib/investigation/ask/rules";
import { type QuestionImage, startQuestion } from "@/lib/investigation/ask/start";

// The answer runs inside this request (it streams through the response),
// capped at 10 model steps; this bounds it.
export const maxDuration = 120;

const bodySchema = z.object({ text: z.string().trim().min(1).max(MAX_QUESTION_CHARS) });
const imageSizeSchema = z.coerce.number().int().positive().max(10_000);

type Body = { text: string; image?: QuestionImage };

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
  const started = await startQuestion(id, body.text, { image: body.image });
  if (!started.ok) return Response.json({ error: started.error }, { status: started.status });

  const result = await answerQuestion(started.incident, started.question);
  // Not awaited: the answer keeps running if the tab closes mid-stream.
  void result.consumeStream();
  return result.toUIMessageStreamResponse({ headers: { "x-question-id": started.question.id } });
}
