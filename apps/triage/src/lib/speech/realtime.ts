import { WebSocket } from "undici";
import { endpointFor } from "@/lib/models/settings";

// Speech to text on the server: a relay between the browser and Meta's
// realtime transcription socket, so the key never leaves the server. Route
// handlers can't take a WebSocket, so the browser opens a session with a GET
// that streams the transcript back (server-sent events) and sends its audio
// with POSTs; each POST body becomes one binary frame upstream.
//
// The socket comes from undici rather than Node's own WebSocket: Node's
// tries HTTP/2 against api.meta.ai, which closes it (1006) before the
// handshake. undici's speaks HTTP/1.1.

// The browser sends 16-bit little-endian mono PCM at 24 kHz (pcm.ts).
export const TRANSCRIBE_MODEL = "muse-voice-transcribe-1.0";

// What the browser reads from the GET. `partial` is the whole utterance so
// far (Meta's partials are cumulative), replacing the one before.
export type TranscribeEvent =
  | { type: "ready" }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "error"; message: string };

type Session = { socket: WebSocket; ended: boolean };

// On globalThis: the GET and the POSTs of one session must find the same
// socket across dev hot reloads.
const g = globalThis as unknown as { triageTranscribeSessions?: Map<string, Session> };
const sessions = (g.triageTranscribeSessions ??= new Map());

// How long Meta gets to accept the handshake (its own deadline is 10 s).
const HANDSHAKE_TIMEOUT_MS = 10_000;
// A session no one ends is closed after this long. Meta bills per minute of
// audio, and a question doesn't take this long to say.
const MAX_SESSION_MS = 5 * 60_000;

// The close codes Meta documents, in words a person can act on.
function closeReason(code: number, reason: string): string | undefined {
  if (code === 1000) return undefined;
  if (code === 1013) return "Meta's transcription is rate limited. Try again in a moment.";
  if (code === 1008) return `Meta refused the audio stream${reason ? `: ${reason}` : ""}.`;
  return `Meta's transcription closed unexpectedly${reason ? `: ${reason}` : ` (code ${code})`}.`;
}

// Opens a session upstream and streams its events until Meta closes it, the
// session runs too long, or `signal` aborts (the browser went away).
export async function openSession(id: string, signal: AbortSignal): Promise<ReadableStream<TranscribeEvent>> {
  const { baseUrl, apiKey } = await endpointFor("meta");
  if (!apiKey) throw new Error("Voice input needs MODEL_API_KEY. Add it to apps/triage/.env.local and restart.");
  if (sessions.has(id)) throw new Error("That transcription session is already open.");

  const url = `${baseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/asr/realtime?sessionId=${encodeURIComponent(id)}`;
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const session: Session = { socket, ended: false };
  sessions.set(id, session);

  // Set once the stream ends, by Meta, a timer, an abort or the reader.
  let done = false;
  return new ReadableStream<TranscribeEvent>({
    start(controller) {
      let ready = false;
      const finish = (error?: string) => {
        if (done) return;
        done = true;
        clearTimeout(handshakeTimer);
        clearTimeout(maxTimer);
        signal.removeEventListener("abort", onAbort);
        sessions.delete(id);
        if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close(1000);
        if (error) controller.enqueue({ type: "error", message: error });
        controller.close();
      };
      const onAbort = () => finish();
      signal.addEventListener("abort", onAbort);
      const handshakeTimer = setTimeout(() => finish("Meta's transcription didn't answer."), HANDSHAKE_TIMEOUT_MS);
      const maxTimer = setTimeout(() => finish("Voice input stops after 5 minutes."), MAX_SESSION_MS);

      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            authorization: { accessToken: `Bearer ${apiKey}` },
            audioEncoding: "PCM_24KHZ",
            model: TRANSCRIBE_MODEL,
            mode: "PUSH_TO_TALK",
            emitAudioProgress: false,
          }),
        );
      };
      socket.onmessage = (event) => {
        if (done || typeof event.data !== "string") return;
        let message: { type?: string; sessionId?: string; transcript?: unknown; final?: unknown; message?: unknown };
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        // The handshake's acknowledgement is the one frame without a type.
        if (!message.type && message.sessionId && !ready) {
          ready = true;
          clearTimeout(handshakeTimer);
          controller.enqueue({ type: "ready" });
        } else if (message.type === "transcript" && typeof message.transcript === "string") {
          controller.enqueue({ type: message.final ? "final" : "partial", text: message.transcript });
        } else if (message.type === "error") {
          finish(typeof message.message === "string" && message.message ? message.message : "Meta's transcription failed.");
        }
      };
      socket.onclose = (event) => finish(closeReason(event.code, event.reason));
      socket.onerror = () => finish("Couldn't reach Meta's transcription.");
    },
    // The reader stopped reading (the browser went away): the socket's own
    // close then finds the stream over.
    cancel() {
      done = true;
      sessions.delete(id);
      socket.close(1000);
    },
  });
}

// Forwards one chunk of audio. False when there is no such open session.
export function sendAudio(id: string, audio: ArrayBuffer): boolean {
  const session = sessions.get(id);
  if (!session || session.ended || session.socket.readyState !== WebSocket.OPEN) return false;
  if (audio.byteLength > 0) session.socket.send(audio);
  return true;
}

// Tells Meta the audio is over; it answers with the final transcript, then
// closes the socket, which ends the GET's stream.
export function endAudio(id: string): boolean {
  const session = sessions.get(id);
  if (!session || session.socket.readyState !== WebSocket.OPEN) return false;
  if (!session.ended) {
    session.ended = true;
    session.socket.send(JSON.stringify({ type: "endStream" }));
  }
  return true;
}
