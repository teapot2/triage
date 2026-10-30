"use client";

import { LoaderCircleIcon, MicIcon } from "lucide-react";
import { type RefObject, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { DictationStatus } from "@/hooks/use-dictation";
import { cn } from "@/lib/utils";

// Voice input's button: a microphone that starts listening, then (red, with
// a ring that pulses) stops it, with a spinner while the last of the
// transcript arrives. The meter beside it is LevelBars.
export function MicButton({
  status,
  disabled,
  onClick,
}: {
  status: DictationStatus;
  disabled?: boolean;
  onClick: () => void;
}) {
  const active = status === "listening" || status === "starting";
  const label =
    status === "listening"
      ? "Stop dictating"
      : status === "starting"
        ? "Starting the microphone…"
        : status === "finishing"
          ? "Finishing the transcript…"
          : "Dictate a question";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled || status === "finishing"}
          aria-label={label}
          aria-pressed={active}
          onClick={onClick}
          className={cn(
            "relative text-muted-foreground",
            active && "bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive",
          )}
        >
          {status === "listening" && (
            <span aria-hidden className="absolute inset-0 animate-ping rounded-[inherit] bg-destructive/20 [animation-duration:1.6s]" />
          )}
          {status === "finishing" || status === "starting" ? <LoaderCircleIcon className="animate-spin" /> : <MicIcon />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{status === "listening" ? "Stop · Enter to send · Esc to cancel" : label}</TooltipContent>
    </Tooltip>
  );
}

// Each bar's share of the level, so the meter moves like a voice rather
// than as one block.
const BAR_WEIGHTS = [0.55, 0.85, 1, 0.75, 0.5];

// A small meter that follows the microphone's loudness, read from `level`
// each animation frame and written straight to the bars' styles.
export function LevelBars({ level, className }: { level: RefObject<number>; className?: string }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    let frame = 0;
    let smooth = 0;
    const tick = () => {
      // Rises fast, falls slower, so speech reads as steady motion.
      const target = level.current ?? 0;
      smooth = target > smooth ? target : smooth * 0.85 + target * 0.15;
      bars.current.forEach((bar, i) => {
        if (bar) bar.style.transform = `scaleY(${Math.max(0.2, Math.min(1, smooth * BAR_WEIGHTS[i] * 1.4))})`;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [level]);

  return (
    <span aria-hidden className={cn("flex h-4 items-center gap-0.5", className)}>
      {BAR_WEIGHTS.map((_, i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el;
          }}
          style={{ transform: "scaleY(0.2)" }}
          className="h-full w-0.5 origin-center rounded-full bg-destructive transition-transform duration-75"
        />
      ))}
    </span>
  );
}
