"use client";

import { SquareIcon, Volume2Icon } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { SettingsSectionHeader } from "@/components/settings-list";
import { Button } from "@/components/ui/button";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useDictationSupported } from "@/hooks/use-dictation";
import { useSpeech, useSpeechAvailable } from "@/hooks/use-speech";
import { useSpeechPreferences } from "@/hooks/use-speech-preferences";
import { speechRates } from "@/lib/speech/preferences";

const DEFAULT_VOICE = "default";
const PREVIEW_KEY = "settings-preview";
const PREVIEW_TEXT =
  "Triage here. The pool leak was ruled out: the p95 latency fell back under 500 milliseconds once the mitigation applied.";

const rateOptions: SegmentedOption<string>[] = speechRates.map((rate) => ({
  value: String(rate),
  label: `${rate}×`,
}));

const subscribeNothing = () => () => {};

const rowClass = "flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between";

// Speech, per browser like Appearance: which of the browser's voices reads
// answers aloud, how fast, and a preview of both; then voice input for the
// Ask composer, the one part that reaches a server (Meta's transcription,
// billed to Triage's key), so it is off until turned on here. Voices are
// read in an effect (the server has none, and some browsers deliver them
// after the page loads), so the first render matches the server's.
export function SpeechSettings() {
  const { preferences, setPreferences } = useSpeechPreferences();
  const { status, key, error, toggle } = useSpeech();
  const available = useSpeechAvailable();
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  // Assumed on the server and while hydrating, so the markup agrees; the
  // browser's answer replaces it right after.
  const supported = useSyncExternalStore(subscribeNothing, () => "speechSynthesis" in window, () => true);
  const canRecord = useDictationSupported();

  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;
    const read = () => setVoices(synth.getVoices());
    read();
    synth.addEventListener("voiceschanged", read);
    return () => synth.removeEventListener("voiceschanged", read);
  }, []);

  const sorted = useMemo(() => sortVoices(voices), [voices]);
  // A voice saved on another machine isn't in this list: show the default,
  // but keep the saved choice until the user picks one.
  const selected = preferences.voice && sorted.some((v) => v.voiceURI === preferences.voice) ? preferences.voice : DEFAULT_VOICE;

  const previewing = key === PREVIEW_KEY && status !== "idle";
  const previewError = key === PREVIEW_KEY && status === "idle" ? error : undefined;

  return (
    <section aria-labelledby="speech" className="flex flex-col gap-3">
      <SettingsSectionHeader
        id="speech"
        title="Speech"
      />
      <div className="divide-y rounded-lg border">
        <div className={rowClass}>
          <div className="flex flex-col gap-0.5">
            <span id="voice-label" className="font-medium text-sm">
              Voice
            </span>
          </div>
          {supported ? (
            <Select
              value={selected}
              onValueChange={(v) => setPreferences({ ...preferences, voice: v === DEFAULT_VOICE ? undefined : v })}
            >
              <SelectTrigger className="min-w-40 max-w-full sm:max-w-72" aria-labelledby="voice-label">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectItem value={DEFAULT_VOICE}>Browser default</SelectItem>
                {sorted.map((voice) => (
                  <SelectItem key={voice.voiceURI} value={voice.voiceURI}>
                    {voice.name} · {voice.lang}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="text-muted-foreground text-sm">Not available in this browser</span>
          )}
        </div>
        <div className={rowClass}>
          <div className="flex flex-col gap-0.5">
            <span id="speed-label" className="font-medium text-sm">
              Speed
            </span>
          </div>
          <SegmentedControl
            value={String(preferences.rate)}
            onValueChange={(v) => setPreferences({ ...preferences, rate: Number(v) })}
            options={rateOptions}
            aria-labelledby="speed-label"
          />
        </div>
        <div className={rowClass}>
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-sm">Preview</span>
            {previewError && <span className="text-destructive text-xs">{previewError}</span>}
          </div>
          <Button variant="outline" size="sm" disabled={!available} onClick={() => toggle(PREVIEW_KEY, PREVIEW_TEXT)}>
            {previewing ? <SquareIcon /> : <Volume2Icon />}
            {previewing ? "Stop" : "Preview"}
          </Button>
        </div>
        <div className={rowClass}>
          <div className="flex flex-col gap-0.5">
            <label htmlFor="voice-input" className="font-medium text-sm">
              Voice input
            </label>
            <span id="voice-input-description" className="max-w-xl text-muted-foreground text-sm">
              A microphone in the Ask composer that transcribes as you speak, with Meta&apos;s muse-voice-transcribe-1.0.
              It uses the same Meta API key (MODEL_API_KEY) as investigations and incidents, and Meta bills each
              minute of audio (about $0.18 an hour).
            </span>
            {preferences.voiceInput && !canRecord && (
              <span className="text-destructive text-xs">This browser can&apos;t record audio here.</span>
            )}
          </div>
          <Switch
            id="voice-input"
            aria-describedby="voice-input-description"
            checked={preferences.voiceInput}
            onCheckedChange={(on) => setPreferences({ ...preferences, voiceInput: on })}
          />
        </div>
        <div className={rowClass}>
          <div className="flex flex-col gap-0.5">
            <label htmlFor="voice-auto-send" className="font-medium text-sm">
              Send when transcription finishes
            </label>
            <span id="voice-auto-send-description" className="max-w-xl text-muted-foreground text-sm">
              Send the question as soon as you stop the microphone and the transcript is in, instead of waiting for
              Enter.
            </span>
          </div>
          <Switch
            id="voice-auto-send"
            aria-describedby="voice-auto-send-description"
            disabled={!preferences.voiceInput}
            checked={preferences.voiceAutoSend}
            onCheckedChange={(on) => setPreferences({ ...preferences, voiceAutoSend: on })}
          />
        </div>
      </div>
    </section>
  );
}

// The voices worth picking first: those in the page's language, then the
// rest, each group in the browser's order. Voices without an id can't be
// chosen, and a repeated id is listed once.
function sortVoices(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice[] {
  if (voices.length === 0) return voices;
  const primary = (lang: string) => lang.toLowerCase().split(/[-_]/)[0];
  const page = primary(document.documentElement.lang || navigator.language || "");
  const unique = [...new Map(voices.filter((v) => v.voiceURI).map((v) => [v.voiceURI, v])).values()];
  const mine = unique.filter((v) => primary(v.lang) === page);
  return [...mine, ...unique.filter((v) => primary(v.lang) !== page)];
}
