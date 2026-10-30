import { formatTime } from "@/components/incident/format";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { UptimeSample } from "@/lib/investigation/uptime/model";
import { cn } from "@/lib/utils";
import { sampleText } from "./endpoint-client";

const SLOTS = 20;

const outcomeColor: Record<UptimeSample["outcome"], string> = {
  ok: "bg-success",
  slow: "bg-warning",
  down: "bg-destructive",
};

const outcomeWord: Record<UptimeSample["outcome"], string> = { ok: "ok", slow: "slow", down: "down" };

// A check's last 20 results, newest at the right, each colored by outcome
// (ok, slow, down); a check with fewer yet leaves the left slots empty so the
// strip keeps its width. Each result's time, status and ms are in its tooltip.
export function ResultStrip({ samples, className }: { samples: UptimeSample[]; className?: string }) {
  const shown = samples.slice(-SLOTS);
  const count = (o: UptimeSample["outcome"]) => shown.filter((s) => s.outcome === o).length;
  const label =
    shown.length === 0
      ? "No results yet"
      : `Last ${shown.length} results: ${count("ok")} ok, ${count("slow")} slow, ${count("down")} down`;
  return (
    <div role="img" aria-label={label} className={cn("flex h-5 items-stretch gap-[3px]", className)}>
      {Array.from({ length: SLOTS - shown.length }, (_, i) => (
        <span key={`empty-${i}`} className="w-1.5 rounded-[2px] bg-muted" />
      ))}
      {shown.map((s) => (
        <Tooltip key={s.at}>
          <TooltipTrigger asChild>
            <span className={cn("w-1.5 rounded-[2px] transition-opacity hover:opacity-70", outcomeColor[s.outcome])} />
          </TooltipTrigger>
          <TooltipContent className="flex-col items-start gap-0.5">
            <span className="font-mono tabular-nums">
              {formatTime(s.at)} UTC · {outcomeWord[s.outcome]}
            </span>
            <span>{sampleText(s)}</span>
            {s.error && <span className="max-w-64 opacity-70">{s.error}</span>}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
