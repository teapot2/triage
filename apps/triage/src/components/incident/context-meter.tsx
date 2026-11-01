"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { contextLimit, type ContextRecord, fullestContext } from "@/lib/models/context";
import { modelLabel } from "@/lib/models/labels";
import { cn } from "@/lib/utils";
import { formatCompact } from "./format";

// How full the context window got: the fullest of `records` (each against
// its own model's window), as a ring and a percent, with that call's
// tokens on hover. Nothing for a model whose window Triage isn't sure of
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
          <Ring share={share} />
          {formatShare(share)}
          <span className="sr-only"> of the context window</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="block max-w-none">
        <p className="mb-1 font-medium">
          Fullest call: {formatCompact(r.context.inputTokens)} of {formatCompact(limit)} tokens
        </p>
        <dl className="grid grid-cols-[auto_auto] gap-x-3 tabular-nums">
          <dt className="opacity-70">Cached</dt>
          <dd className="text-right">{formatCompact(r.context.cachedInputTokens)}</dd>
          <dt className="opacity-70">Output</dt>
          <dd className="text-right">{formatCompact(r.context.outputTokens)}</dd>
          <dt className="opacity-70">Reasoning</dt>
          <dd className="text-right">{formatCompact(r.context.reasoningTokens)}</dd>
        </dl>
        <p className="mt-1 opacity-70">{modelLabel(r.model, r.provider)}</p>
      </TooltipContent>
    </Tooltip>
  );
}

// The same in words, for a details list: "4% · 41.8K of 1M tokens".
export function contextText(r: ContextRecord): string | undefined {
  const limit = contextLimit(r.provider, r.model);
  if (!r.context || !limit) return undefined;
  return `${formatShare(r.context.inputTokens / limit)} · ${formatCompact(r.context.inputTokens)} of ${formatCompact(limit)} tokens`;
}

// "<1%" rather than a 0% that reads as nothing sent.
export const formatShare = (share: number) => (share > 0 && share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`);

// Plain under 70%, amber to 85%, red past it: models get less reliable
// well before the window is full.
const toneOf = (share: number) => (share >= 0.85 ? "text-destructive" : share >= 0.7 ? "text-warning" : undefined);

function Ring({ share }: { share: number }) {
  const r = 6;
  const length = 2 * Math.PI * r;
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-3.5 -rotate-90">
      <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={`${Math.min(share, 1) * length} ${length}`}
      />
    </svg>
  );
}
