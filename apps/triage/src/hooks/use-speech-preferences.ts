"use client";

import { useSyncExternalStore } from "react";
import {
  defaultSpeechPreferences,
  readSpeechPreferences,
  SPEECH_STORAGE_KEY,
  type SpeechPreferences,
  writeSpeechPreferences,
} from "@/lib/speech/preferences";

// The saved preferences: this tab's writes, and other tabs' via the storage
// event. The snapshot is read once and kept, so useSyncExternalStore gets the
// same object until a write or a storage event replaces it.
const listeners = new Set<() => void>();
let snapshot: SpeechPreferences | undefined;

const notify = () => {
  for (const l of listeners) l();
};

function onStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== SPEECH_STORAGE_KEY) return;
  snapshot = readSpeechPreferences();
  notify();
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  if (listeners.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot(): SpeechPreferences {
  snapshot ??= readSpeechPreferences();
  return snapshot;
}

// The saved preferences and a setter. The server render assumes the defaults
// (it can't see localStorage); hydration then reads the real value.
export function useSpeechPreferences() {
  const preferences = useSyncExternalStore(subscribe, getSnapshot, () => defaultSpeechPreferences);

  const setPreferences = (next: SpeechPreferences) => {
    writeSpeechPreferences(next);
    snapshot = next;
    notify();
  };

  return { preferences, setPreferences };
}
