"use client";

import { ProgressRing } from "@/components/ui/progress-ring";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { contextLimit, type ContextRecord, fullestContext } from "@/lib/models/context";
import { modelLabel } from "@/lib/models/labels";
import { cn } from "@/lib/utils";
import { formatCompact } from "./format";

// How full the context window got: the fullest of `records` (each against
// its own model's window), as a ring and a percent, with that call's
// tokens on hover: a run's stat, for a finished stage. A conversation's
// context, with what fills it, is ContextWindow (context-window.tsx).
// Nothing for a model whose window Triage isn't sure of
// (models/context.ts), or before the first call finishes.
export function ContextMeter({ records, className }: { records: ContextRecord[]; className?: string }) {
  const r = fullestContext(records);
  if (!r?.context) return null;
  const limit = contextLimit(r.provider, r.model)!;
  const share = r.context.inputTokens / limit;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex cursor-default items-center gap-1 tabular-nums decoration-dotted underline-offset-4 hover:underline",
            toneOf(share),
            className,
          )}
        >
          <ProgressRing value={share} className="size-3.5" />
          {formatShare(share)}
          <span className="sr-only"> of the context window</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="block w-56 max-w-none">
        <div className="flex items-center gap-2.5">
          <ProgressRing value={share} className={cn("size-7", toneOf(share))} />
          <div className="flex min-w-0 flex-col tabular-nums">
            <span className="font-medium">
              Fullest call · {formatShare(share)} used
            </span>
            <span className="opacity-70">
              {formatCompact(r.context.inputTokens)} of {formatCompact(limit)} tokens
            </span>
          </div>
        </div>
        <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 border-current/15 border-t pt-2 tabular-nums">
          <dt className="opacity-70">Cached</dt>
          <dd className="text-right">{formatCompact(r.context.cachedInputTokens)}</dd>
          <dt className="opacity-70">Output</dt>
          <dd className="text-right">{formatCompact(r.context.outputTokens)}</dd>
          <dt className="opacity-70">Reasoning</dt>
          <dd className="text-right">{formatCompact(r.context.reasoningTokens)}</dd>
        </dl>
        <p className="mt-2 opacity-70">{modelLabel(r.model, r.provider)}</p>
      </TooltipContent>
    </Tooltip>
  );
}

// "<1%" rather than a 0% that reads as nothing sent.
export const formatShare = (share: number) => (share > 0 && share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`);

// Plain under 70%, amber to 85%, red past it: models get less reliable
// well before the window is full.
export const toneOf = (share: number) => (share >= 0.85 ? "text-destructive" : share >= 0.7 ? "text-warning" : undefined);
