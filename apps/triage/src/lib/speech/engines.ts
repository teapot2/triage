"use client";

import type { SpeechEngineId } from "./preferences";

// What speaks. An engine turns text into sound behind one small interface, so
// another (a server voice, say) can be added beside the browser's without the
// hook or the button changing. Only the browser's own voices (the Web Speech
// API) exist now: no server, no key, works offline.

export interface Playback {
  // Settles when the speech ends or is stopped; rejects if it fails midway.
  done: Promise<void>;
  stop(): void;
}

export interface SpeechEngine {
  id: SpeechEngineId;
  // Whether this engine can run in this browser at all.
  available(): boolean;
  // Resolves once the audio is playing; rejects with a message a person can read.
  speak(text: string, options: { voice?: string; rate: number; signal: AbortSignal }): Promise<Playback>;
}

// Chrome stops a long utterance silently, so text is spoken a sentence at a
// time, with a sentence still over this length cut at a comma or a space.
const MAX_CHUNK_CHARS = 200;

// The browser gives up on a voice that never starts (a locked-down or
// voiceless install) without an error; this is how long to wait for it.
const START_TIMEOUT_MS = 5000;
// Voices load after the page on some browsers: how long to wait for them.
const VOICES_TIMEOUT_MS = 1000;

function abortError() {
  return new DOMException("Speech was cancelled", "AbortError");
}

export function splitIntoChunks(text: string): string[] {
  const chunks: string[] = [];
  for (const sentence of text.split(/(?<=[.!?…])\s+/)) {
    let rest = sentence.trim();
    while (rest.length > MAX_CHUNK_CHARS) {
      const head = rest.slice(0, MAX_CHUNK_CHARS);
      const comma = head.lastIndexOf(",");
      const space = head.lastIndexOf(" ");
      const cut = comma > 0 ? comma + 1 : space > 0 ? space : MAX_CHUNK_CHARS;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) chunks.push(rest);
  }
  return chunks;
}

// The voices, waiting once (with a limit) for the browser to load them when
// the list is still empty.
function loadVoices(synth: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
  const loaded = synth.getVoices();
  if (loaded.length > 0) return Promise.resolve(loaded);
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      synth.removeEventListener("voiceschanged", finish);
      resolve(synth.getVoices());
    };
    const timer = setTimeout(finish, VOICES_TIMEOUT_MS);
    synth.addEventListener("voiceschanged", finish);
  });
}

// Chrome garbage-collects an utterance that nothing references and then never
// calls its handlers: they are kept here until their speech is over.
const speaking = new Set<SpeechSynthesisUtterance>();

const browserEngine: SpeechEngine = {
  id: "browser",

  available() {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  },

  async speak(text, { voice, rate, signal }) {
    const synth = window.speechSynthesis;
    // Without a saved voice the browser picks its default for the language.
    const chosen = voice ? (await loadVoices(synth)).find((v) => v.voiceURI === voice) : undefined;
    if (signal.aborted) throw abortError();

    const chunks = splitIntoChunks(text);
    if (chunks.length === 0) throw new Error("Nothing to read");
    const lang = document.documentElement.lang || "en-US";
    const utterances = chunks.map((chunk) => {
      const utterance = new SpeechSynthesisUtterance(chunk);
      utterance.rate = rate;
      if (chosen) utterance.voice = chosen;
      else utterance.lang = lang;
      return utterance;
    });

    synth.cancel();

    return new Promise<Playback>((resolve, reject) => {
      let started = false;
      let over = false;
      let remaining = utterances.length;
      let finishDone: () => void;
      let failDone: (error: Error) => void;
      const done = new Promise<void>((res, rej) => {
        finishDone = res;
        failDone = rej;
      });
      // Nobody may be listening to `done` when it fails before playback.
      done.catch(() => {});

      const startTimer = setTimeout(() => end(new Error("The browser voice didn't start")), START_TIMEOUT_MS);

      // The one way out. A failure before the first sound rejects the speak;
      // one midway rejects `done`; no error is a normal end or a stop.
      function end(error?: Error) {
        if (over) return;
        over = true;
        clearTimeout(startTimer);
        signal.removeEventListener("abort", stop);
        for (const utterance of utterances) speaking.delete(utterance);
        if (error) synth.cancel();
        if (!started) {
          if (error) reject(error);
          else reject(abortError());
        }
        if (error) failDone(error);
        else finishDone();
      }
      function stop() {
        if (over) return;
        synth.cancel();
        end();
      }

      const playback: Playback = { done, stop };
      signal.addEventListener("abort", stop);

      for (const utterance of utterances) {
        utterance.onstart = () => {
          if (started || over) return;
          started = true;
          clearTimeout(startTimer);
          resolve(playback);
        };
        utterance.onend = () => {
          remaining -= 1;
          if (remaining === 0) end();
        };
        utterance.onerror = (event) => {
          if (event.error === "interrupted" || event.error === "canceled") end();
          else end(new Error(started ? "The browser voice stopped unexpectedly" : "The browser voice didn't start"));
        };
      }
      for (const utterance of utterances) {
        speaking.add(utterance);
        synth.speak(utterance);
      }
    });
  },
};

export const engines: Record<SpeechEngineId, SpeechEngine> = {
  browser: browserEngine,
};
