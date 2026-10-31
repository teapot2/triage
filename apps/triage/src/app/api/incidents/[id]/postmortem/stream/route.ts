import { followDraft, type PostmortemStreamEvent } from "@/lib/investigation/postmortem/live";
import { getIncident } from "@/lib/investigation/store";

// The postmortem being written, as server-sent events: the latest draft,
// then each change, then `end` once it is ready or failed and saved. When
// this server isn't writing one (it finished, or another process is), it
// ends at once: the record has what there is.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await getIncident(id))) return Response.json({ error: `unknown incident: ${id}` }, { status: 404 });

  const encoder = new TextEncoder();
  let stop: (() => void) | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const close = () => {
        if (!open) return;
        open = false;
        stop?.();
        controller.close();
      };
      const send = (event: PostmortemStreamEvent) => {
        if (open) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      stop = followDraft(id, (event) => {
        if (event) return send({ type: "draft", ...event });
        send({ type: "end" });
        close();
      });
      if (!stop) {
        send({ type: "end" });
        close();
      }
      req.signal.addEventListener("abort", close);
    },
    cancel() {
      stop?.();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" },
  });
}
