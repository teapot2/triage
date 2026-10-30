"use client";

import { CircleXIcon, LoaderCircleIcon, SquareIcon, Volume2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSpeech, useSpeechAvailable } from "@/hooks/use-speech";
import { speakableText } from "@/lib/speech/text";
import { cn } from "@/lib/utils";

// How long a failure stays on the button before it is idle again.
const ERROR_MS = 4000;

// Reads `text` aloud, or stops it. Reusable wherever Triage writes prose:
// `id` names what is read (one playback runs at a time across the app, so
// pressing another button, or this one again, stops it). Renders nothing
// when there is nothing to say or this browser has no voice.
export function SpeakButton({
  id,
  text,
  label = "Read aloud",
  className,
}: {
  id: string;
  text: string;
  label?: string;
  className?: string;
}) {
  const { status, key, error, toggle } = useSpeech();
  const available = useSpeechAvailable();
  const spoken = useMemo(() => speakableText(text), [text]);

  const mine = key === id;
  const failure = mine && status === "idle" ? error : undefined;

  // A failure shows for a few seconds, then the button is idle again. A new
  // failure (the value changing, even back to the same text after a retry)
  // shows afresh.
  const [expired, setExpired] = useState(false);
  const [lastFailure, setLastFailure] = useState(failure);
  if (failure !== lastFailure) {
    setLastFailure(failure);
    setExpired(false);
  }
  useEffect(() => {
    if (!failure) return;
    const timer = setTimeout(() => setExpired(true), ERROR_MS);
    return () => clearTimeout(timer);
  }, [failure]);

  if (!spoken || !available) return null;

  const speaking = mine && status === "speaking";
  const loading = mine && status === "loading";
  const failed = failure !== undefined && !expired;
  const name = failed ? `Couldn't read aloud: ${failure}` : speaking ? "Stop" : loading ? "Loading…" : label;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(className)}
          aria-label={failed ? label : name}
          aria-pressed={speaking || undefined}
          onClick={() => toggle(id, text)}
        >
          {failed ? (
            <CircleXIcon />
          ) : speaking ? (
            <SquareIcon />
          ) : loading ? (
            <LoaderCircleIcon className="animate-spin" />
          ) : (
            <Volume2Icon />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  );
}
