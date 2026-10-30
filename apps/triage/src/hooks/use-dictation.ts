"use client";

import { type RefObject, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { type Dictation, dictationSupported, startDictation } from "@/lib/speech/dictation";

export type DictationStatus = "idle" | "starting" | "listening" | "finishing";

export interface DictationControls {
  status: DictationStatus;
  // The last failure, cleared on the next start.
  error: string | undefined;
  // The microphone's loudness, 0 to 1, for a meter to read each frame
  // without re-rendering the composer twenty times a second.
  level: RefObject<number>;
  start(): void;
  // Stops listening and resolves with the final transcript, or undefined
  // when it failed (see error) or was cancelled.
  finish(): Promise<string | undefined>;
  cancel(): void;
}

// One dictation at a time for the component that holds it. `onText` gets
// the whole transcript so far each time it grows. Cancelled on unmount.
export function useDictation(onText: (text: string) => void): DictationControls {
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [error, setError] = useState<string>();
  const level = useRef(0);
  const session = useRef<Dictation | undefined>(undefined);
  // Counts every start and cancel; a session that opens for an older count
  // was cancelled while it opened.
  const generation = useRef(0);
  const textRef = useRef(onText);
  useEffect(() => {
    textRef.current = onText;
  });

  const cancel = useCallback(() => {
    generation.current += 1;
    session.current?.cancel();
    session.current = undefined;
    level.current = 0;
    setStatus("idle");
  }, []);

  const start = useCallback(() => {
    if (session.current) return;
    const mine = ++generation.current;
    setError(undefined);
    setStatus("starting");
    startDictation({
      onText: (text) => {
        if (mine === generation.current) textRef.current(text);
      },
      onLevel: (value) => {
        if (mine === generation.current) level.current = value;
      },
      onError: (message) => {
        if (mine !== generation.current) return;
        // Over: a session that resolves after this is dropped.
        generation.current += 1;
        session.current = undefined;
        level.current = 0;
        setError(message);
        setStatus("idle");
      },
    }).then(
      (dictation) => {
        if (mine !== generation.current) return dictation.cancel();
        session.current = dictation;
        setStatus("listening");
      },
      (err: unknown) => {
        if (mine !== generation.current) return;
        setError(err instanceof Error ? err.message : "Voice input failed");
        setStatus("idle");
      },
    );
  }, []);

  const finish = useCallback(async () => {
    const dictation = session.current;
    if (!dictation) {
      // Still opening: there is nothing to keep yet.
      cancel();
      return undefined;
    }
    const mine = generation.current;
    setStatus("finishing");
    try {
      const text = await dictation.finish();
      return mine === generation.current ? text : undefined;
    } catch (err) {
      if (mine === generation.current) setError(err instanceof Error ? err.message : "Voice input failed");
      return undefined;
    } finally {
      if (mine === generation.current) {
        session.current = undefined;
        level.current = 0;
        setStatus("idle");
      }
    }
  }, [cancel]);

  useEffect(() => cancel, [cancel]);

  return { status, error, level, start, finish, cancel };
}

const subscribeNothing = () => () => {};

// Whether this browser can record here (a secure page with a microphone
// API). False on the server render and while hydrating.
export function useDictationSupported(): boolean {
  return useSyncExternalStore(subscribeNothing, dictationSupported, () => false);
}
