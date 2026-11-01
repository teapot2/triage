"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ProgressRing } from "@/components/ui/progress-ring";
import { cn } from "@/lib/utils";
import { formatShare, toneOf } from "./context-meter";
import { formatCompact } from "./format";

// One part of what fills a context window: a row in the card, and a
// segment of its bar.
export interface ContextSegment {
  key: string;
  label: string;
  tokens: number;
  // Beside the count, muted: "last 6 of 9".
  detail?: string;
}

// The categorical slots, in a fixed order (the data-viz reference palette,
// validated for both themes); the order follows the segments, so a part
// keeps its colour whatever else is there.
const swatches = [
  "bg-[#2a78d6] dark:bg-[#3987e5]",
  "bg-[#eb6834] dark:bg-[#d95926]",
  "bg-[#1baf7a] dark:bg-[#199e70]",
  "bg-[#eda100] dark:bg-[#c98500]",
  "bg-[#e87ba4] dark:bg-[#d55181]",
  "bg-[#008300] dark:bg-[#008300]",
  "bg-[#6250d6] dark:bg-[#9085e9]",
];

// How full a conversation's context window is, like Claude's /context: a
// ring and a percent that open a card with the total against the window,
// a bar of what fills it, a row per part that has any (each keeps its
// colour by position, so pass every part), and what's free. `note` goes
// under the rows (where the numbers come from); `className` places the
// trigger.
export function ContextWindow({
  used,
  limit,
  segments,
  note,
  className,
}: {
  used: number;
  limit: number;
  segments: ContextSegment[];
  note?: ReactNode;
  className?: string;
}) {
  const share = used / limit;
  const shown = segments.map((s, i) => ({ ...s, swatch: swatches[i % swatches.length] }));
  const filled = shown.filter((s) => s.tokens > 0);
  const total = filled.reduce((sum, s) => sum + s.tokens, 0);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={`Context window: ${formatShare(share)} used`}
          className={cn("gap-1.5 text-muted-foreground tabular-nums", toneOf(share), className)}
        >
          <ProgressRing value={share} className="size-3.5" />
          {formatShare(share)}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-80 p-3 text-xs">
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-medium">Context window</span>
          <span className="text-muted-foreground tabular-nums">
            {formatCompact(used)} / {formatCompact(limit)} ·{" "}
            <span className={cn("text-foreground", toneOf(share))}>{formatShare(share)}</span>
          </span>
        </div>
        {/* What fills the used part, 2 px apart; the rows below carry the
            names and numbers, so colour is never the only label. */}
        {total > 0 && (
          <div aria-hidden className="mt-2 flex h-2 gap-0.5">
            {filled.map((s) => (
              <span
                key={s.key}
                className={cn("min-w-0.5 rounded-[2px]", s.swatch)}
                style={{ flexGrow: s.tokens, flexBasis: 0 }}
              />
            ))}
          </div>
        )}
        <dl className="mt-2.5 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 tabular-nums">
          {shown.map((s) =>
            s.tokens > 0 || s.detail ? (
            <div key={s.key} className="contents">
              <dt className="flex min-w-0 items-center gap-2">
                <span aria-hidden className={cn("size-2 shrink-0 rounded-[2px]", s.swatch)} />
                <span className="truncate">{s.label}</span>
                {s.detail && <span className="truncate text-muted-foreground">{s.detail}</span>}
              </dt>
              <dd className="text-right">{formatCompact(s.tokens)}</dd>
            </div>
            ) : null,
          )}
          <dt className="flex items-center gap-2 text-muted-foreground">
            <span aria-hidden className="size-2 shrink-0 rounded-[2px] border border-muted-foreground/40" />
            Free space
          </dt>
          <dd className="text-right text-muted-foreground">{formatCompact(Math.max(limit - used, 0))}</dd>
        </dl>
        {note && <div className="mt-2.5 border-t pt-2 text-muted-foreground">{note}</div>}
      </PopoverContent>
    </Popover>
  );
}
