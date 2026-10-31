import { readQuestionImage } from "@/lib/investigation/ask/images";
import { getIncident } from "@/lib/investigation/store";

// The screenshot attached to a question, for the thread. A question's image
// never changes, so the browser may keep it.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; qid: string }> }) {
  const { id, qid } = await params;
  const question = (await getIncident(id))?.questions?.find((q) => q.id === qid);
  const image = question && (await readQuestionImage(id, question));
  if (!image) return Response.json({ error: `no image on ${id}/${qid}` }, { status: 404 });
  return new Response(new Uint8Array(image.bytes), {
    headers: {
      "content-type": image.mediaType,
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}
