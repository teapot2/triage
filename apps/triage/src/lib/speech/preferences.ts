// Speech preferences: which browser voice reads aloud and how fast, and
// whether the Ask composer takes voice input (off by default: it is billed
// by Meta) and sends once the transcript is in. A per-browser choice saved
// in localStorage (voices and microphones differ from one device to the
// next), kept out of the client hook so a Server Component or a plain test
// can import it; the hook adds the subscription.

// The engines that can speak. Only the browser's own voices for now; the
// engine interface in engines.ts leaves room for another.
export type SpeechEngineId = "browser";

// `voice` is the browser voice's voiceURI.
export type SpeechPreferences = { voice?: string; rate: number; voiceInput: boolean; voiceAutoSend: boolean };

export const SPEECH_STORAGE_KEY = "speech";

export const defaultSpeechPreferences: SpeechPreferences = { rate: 1, voiceInput: false, voiceAutoSend: false };

export const speechRates = [0.8, 1, 1.2, 1.5] as const;

// What is saved, checked field by field: a hand-edited or older value
// falls back to the default for that field instead of breaking playback.
function parse(saved: string | null): SpeechPreferences {
  if (!saved) return defaultSpeechPreferences;
  let value: unknown;
  try {
    value = JSON.parse(saved);
  } catch {
    return defaultSpeechPreferences;
  }
  if (typeof value !== "object" || value === null) return defaultSpeechPreferences;
  const { voice, rate, voiceInput, voiceAutoSend } = value as Record<string, unknown>;
  return {
    rate: speechRates.find((r) => r === rate) ?? defaultSpeechPreferences.rate,
    voiceInput: voiceInput === true,
    voiceAutoSend: voiceAutoSend === true,
    ...(typeof voice === "string" && voice ? { voice } : {}),
  };
}

export function readSpeechPreferences(): SpeechPreferences {
  try {
    return parse(localStorage.getItem(SPEECH_STORAGE_KEY));
  } catch {
    return defaultSpeechPreferences;
  }
}

export function writeSpeechPreferences(preferences: SpeechPreferences): void {
  try {
    localStorage.setItem(SPEECH_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Storage blocked (some private modes): the choice lasts this page only.
  }
}
