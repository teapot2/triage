import { connection } from "next/server";
import { getIncident } from "@/lib/investigation/store";
import { incidentKeywords } from "@/lib/speech/keywords";
import { endAudio, openSession, sendAudio, type TranscribeEvent } from "@/lib/speech/realtime";

// Voice input for the Ask composer, relayed to Meta's realtime transcription
// (lib/speech/realtime.ts). The browser names the session (?id=, a UUID it
// made), opens it with a GET that streams the transcript as server-sent
// events, then POSTs its audio to the same ?id= in order, and a last POST
// with ?end=1. Meta bills per minute of audio. With ?incident=<id>, the
// incident's service, route and host names bias the transcription
// (lib/speech/keywords.ts); an unknown incident just goes without.

const idPattern = /^[0-9a-f-]{36}$/i;

function sessionId(req: Request): string | undefined {
  const id = new URL(req.url).searchParams.get("id");
  return id && idPattern.test(id) ? id : undefined;
}

export async function GET(req: Request) {
  await connection();
  const id = sessionId(req);
  if (!id) return Response.json({ error: "expected ?id=<uuid>" }, { status: 400 });

  const incidentId = new URL(req.url).searchParams.get("incident");
  const incident = incidentId ? await getIncident(incidentId).catch(() => undefined) : undefined;

  let events: ReadableStream<TranscribeEvent>;
  try {
    events = await openSession(id, req.signal, incident ? incidentKeywords(incident) : []);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 503 });
  }
  const encoder = new TextEncoder();
  const body = events.pipeThrough(
    new TransformStream<TranscribeEvent, Uint8Array>({
      transform(event, controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      },
    }),
  );
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}

export async function POST(req: Request) {
  await connection();
  const id = sessionId(req);
  if (!id) return Response.json({ error: "expected ?id=<uuid>" }, { status: 400 });

  const ok = new URL(req.url).searchParams.has("end") ? endAudio(id) : sendAudio(id, await req.arrayBuffer());
  if (!ok) return Response.json({ error: "No open transcription session with that id" }, { status: 404 });
  return new Response(null, { status: 204 });
}
