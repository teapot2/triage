"use client";

import { usePathname } from "next/navigation";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { engines, type Playback } from "@/lib/speech/engines";
import { readSpeechPreferences } from "@/lib/speech/preferences";
import { speakableText } from "@/lib/speech/text";

export type SpeechStatus = "idle" | "loading" | "speaking";

type SpeechState = {
  status: SpeechStatus;
  // What is playing or loading; after a failure, what failed (status idle),
  // so the button that asked can show why. Undefined after a normal end.
  key: string | undefined;
  // The last failure, cleared on the next speak.
  error: string | undefined;
};

// One playback at a time, across the whole app: a module-level store, so a
// button in one panel stops what another started.
const idle: SpeechState = { status: "idle", key: undefined, error: undefined };
let state = idle;
const listeners = new Set<() => void>();

function set(next: SpeechState) {
  state = next;
  for (const l of listeners) l();
}

let current: { controller: AbortController; playback?: Playback } | undefined;
// Counts every speak and stop; a result that arrives for an older count was
// superseded and must not change the state.
let generation = 0;
let pageHideBound = false;

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong";
}

// Ends whatever is loading or playing, without touching the state.
function halt() {
  generation += 1;
  current?.controller.abort();
  current?.playback?.stop();
  current = undefined;
}

function stop() {
  halt();
  set(idle);
}

function speak(key: string, text: string) {
  halt();
  const mine = generation;
  const spoken = speakableText(text);
  if (!spoken) {
    set({ status: "idle", key, error: "Nothing to read" });
    return;
  }
  const engine = engines.browser;
  if (!engine.available()) {
    set({ status: "idle", key, error: "This browser can't read aloud" });
    return;
  }
  set({ status: "loading", key, error: undefined });

  const { voice, rate } = readSpeechPreferences();
  const controller = new AbortController();
  current = { controller };
  const fail = (error: unknown) => {
    if (mine !== generation) return;
    current = undefined;
    set({ status: "idle", key, error: messageOf(error) });
  };

  engine.speak(spoken, { voice, rate, signal: controller.signal }).then((playback) => {
    if (mine !== generation) {
      playback.stop();
      return;
    }
    current = { controller, playback };
    set({ status: "speaking", key, error: undefined });
    return playback.done.then(() => {
      if (mine !== generation) return;
      current = undefined;
      set(idle);
    }, fail);
  }, fail);
}

function toggle(key: string, text: string) {
  if (state.status !== "idle" && state.key === key) stop();
  else speak(key, text);
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  // Once, for good: a page that is hidden or left stops talking, even if no
  // button is mounted any more.
  if (!pageHideBound) {
    pageHideBound = true;
    window.addEventListener("pagehide", stop);
  }
  return () => {
    listeners.delete(onChange);
  };
}

// The playing state and the controls. Every component shares one playback.
export function useSpeech() {
  const snapshot = useSyncExternalStore(subscribe, () => state, () => idle);
  return useMemo(() => ({ ...snapshot, speak, stop, toggle }), [snapshot]);
}

const subscribeNothing = () => () => {};

// Whether reading aloud can work here. False on the server render and the
// hydrating one (no window to ask), true after if the browser has a voice
// engine, so a button doesn't flash or mismatch on load.
export function useSpeechAvailable(): boolean {
  return useSyncExternalStore(subscribeNothing, () => engines.browser.available(), () => false);
}

// Stops the reading when the page changes within the app: the button that
// could stop it is gone with the page it was on. Mounted once, in the root
// layout. The first render stops nothing (nothing plays yet).
export function SpeechSync() {
  const pathname = usePathname();
  useEffect(() => () => stop(), [pathname]);
  return null;
}
