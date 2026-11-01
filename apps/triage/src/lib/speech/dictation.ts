"use client";

import { sseJsonStream } from "@/lib/sse";
import { level, Resampler, TRANSCRIBE_SAMPLE_RATE, toPcm16 } from "./pcm";
import type { TranscribeEvent } from "./realtime";

// Voice input: the microphone, streamed to /api/speech/transcribe (which
// relays it to Meta's muse-voice-transcribe) while the transcript streams
// back. Kept out of the hook so the hook only holds React state.

export interface Dictation {
  // Stops the microphone and resolves with the final transcript once Meta
  // has it; rejects with a message a person can read.
  finish(): Promise<string>;
  // Stops everything and drops the transcript.
  cancel(): void;
}

export interface DictationCallbacks {
  // The whole transcript so far, replacing the last.
  onText(text: string): void;
  // How loud the microphone is, 0 to 1, about 20 times a second.
  onLevel(level: number): void;
  // A failure while listening (not after finish, which rejects instead).
  onError(message: string): void;
}

export interface DictationOptions {
  // The incident being asked about: its service, route and host names bias
  // the transcription (lib/speech/keywords.ts).
  incidentId?: string;
}

// How long the final transcript may take after the audio ends.
const FINAL_TIMEOUT_MS = 10_000;
const ENDPOINT = "/api/speech/transcribe";
// Audio goes up in requests of at least this much (200 ms at 24 kHz, 16-bit),
// rather than one per block; the last request after finish() takes the rest.
const MIN_CHUNK_BYTES = TRANSCRIBE_SAMPLE_RATE * 2 * 0.2;

// The microphone's samples, in blocks of 2048 (about 40 ms), to the page.
const TAP = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.block = new Float32Array(2048); this.filled = 0; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.block[this.filled++] = channel[i];
        if (this.filled === this.block.length) {
          this.port.postMessage(this.block.slice());
          this.filled = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("triage-mic-tap", Tap);
`;

export function dictationSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof AudioWorkletNode !== "undefined"
  );
}

function micError(error: unknown): Error {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return new Error("Microphone access is blocked for this site");
  if (name === "NotFoundError" || name === "OverconstrainedError") return new Error("No microphone found");
  if (name === "NotReadableError") return new Error("The microphone is in use by another app");
  return new Error("Couldn't start the microphone");
}

const messageOf = (error: unknown) => (error instanceof Error && error.message ? error.message : "Voice input failed");

// Asks for the microphone and starts recording, then opens a transcription
// session. Resolves once recording has started; audio recorded before Meta
// is ready is held, then sent. A failure to open the session comes through
// onError.
export async function startDictation(
  { onText, onLevel, onError }: DictationCallbacks,
  { incidentId }: DictationOptions = {},
): Promise<Dictation> {
  if (!dictationSupported()) throw new Error("This browser can't record audio here");

  let mic: MediaStream;
  try {
    mic = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    throw micError(error);
  }

  const id = crypto.randomUUID();
  const aborter = new AbortController();
  let context: AudioContext | undefined;
  let text = "";
  let ready = false;
  // Set once finish() or cancel() is called, or a failure ends the session.
  let stopping = false;
  let over = false;
  let failure: string | undefined;
  let sending = false;
  let endSent = false;
  let pending: ArrayBuffer[] = [];
  let pendingBytes = 0;
  let streamEnded = () => {};
  const ended = new Promise<void>((resolve) => {
    streamEnded = resolve;
  });

  const stopMic = () => {
    for (const track of mic.getTracks()) track.stop();
    void context?.close().catch(() => {});
    context = undefined;
    onLevel(0);
  };

  // Ends the session for good; reports a failure unless finish() is
  // waiting to reject with it.
  const fail = (message: string) => {
    if (over) return;
    over = true;
    failure ??= message;
    stopMic();
    aborter.abort();
    streamEnded();
    if (!stopping) onError(message);
  };

  const post = (query: string, body?: ArrayBuffer) =>
    fetch(`${ENDPOINT}?id=${id}${query}`, { method: "POST", body, signal: aborter.signal }).then(async (res) => {
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
    });

  // Sends what is recorded, one request at a time so the chunks arrive in
  // order; after finish(), the end of the audio once it has all gone.
  const pump = () => {
    if (!ready || sending || over) return;
    if (pendingBytes >= MIN_CHUNK_BYTES || (stopping && pendingBytes > 0)) {
      const chunks = pending;
      pending = [];
      const body = new Uint8Array(pendingBytes);
      pendingBytes = 0;
      let offset = 0;
      for (const chunk of chunks) {
        body.set(new Uint8Array(chunk), offset);
        offset += chunk.byteLength;
      }
      sending = true;
      post("", body.buffer).then(
        () => {
          sending = false;
          pump();
        },
        (error) => fail(messageOf(error)),
      );
    } else if (stopping && !endSent) {
      endSent = true;
      post("&end=1").catch((error) => fail(messageOf(error)));
    }
  };

  try {
    context = new AudioContext();
    const url = URL.createObjectURL(new Blob([TAP], { type: "text/javascript" }));
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const source = context.createMediaStreamSource(mic);
    const tap = new AudioWorkletNode(context, "triage-mic-tap", { numberOfOutputs: 1, outputChannelCount: [1] });
    // Muted: the tap only runs while connected to the output.
    const mute = context.createGain();
    mute.gain.value = 0;
    source.connect(tap).connect(mute).connect(context.destination);
    const resampler = new Resampler(context.sampleRate, TRANSCRIBE_SAMPLE_RATE);
    tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (stopping || over) return;
      onLevel(level(event.data));
      const pcm = toPcm16(resampler.push(event.data));
      pending.push(pcm);
      pendingBytes += pcm.byteLength;
      pump();
    };
  } catch {
    stopMic();
    throw new Error("Couldn't start the microphone");
  }

  // The session, opened while the microphone already records (what is
  // said meanwhile waits in `pending`), and its transcript, read until the
  // server closes the stream.
  void (async () => {
    try {
      const incident = incidentId ? `&incident=${encodeURIComponent(incidentId)}` : "";
      const res = await fetch(`${ENDPOINT}?id=${id}${incident}`, { signal: aborter.signal, cache: "no-store" });
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        return fail(data.error ?? `HTTP ${res.status}`);
      }
      const reader = sseJsonStream<TranscribeEvent>(res.body).getReader();
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        const event = next.value;
        if (event.type === "ready") {
          ready = true;
          pump();
        } else if (event.type === "partial" || event.type === "final") {
          text = event.text;
          onText(text);
        } else if (event.type === "error") {
          fail(event.message);
        }
      }
      // Meta closes the stream after the final transcript; before finish(),
      // a close is a failure.
      if (!endSent) fail("Voice input stopped unexpectedly");
      else streamEnded();
    } catch {
      if (!over) fail("Lost the connection to the server");
    }
  })();

  return {
    async finish() {
      if (stopping) return text;
      stopping = true;
      stopMic();
      pump();
      const timeout = setTimeout(() => fail("The transcript didn't arrive in time"), FINAL_TIMEOUT_MS);
      await ended;
      clearTimeout(timeout);
      over = true;
      aborter.abort();
      if (failure) throw new Error(failure);
      return text;
    },
    cancel() {
      stopping = true;
      over = true;
      stopMic();
      aborter.abort();
      streamEnded();
    },
  };
}
