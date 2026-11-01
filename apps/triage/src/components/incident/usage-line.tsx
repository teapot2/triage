"use client";

import { CoinsIcon } from "lucide-react";
import { ProgressRing } from "@/components/ui/progress-ring";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cachedShare, formatCost, type IncidentUsage, type UsageTotal } from "@/lib/investigation/cost";
import { stageIds, stageLabels } from "@/lib/models/stages";
import { cn } from "@/lib/utils";
import { formatShare, toneOf } from "./context-meter";
import { formatCompact, formatPercent } from "./format";

// What the incident's model calls cost, in one line for the header: "$0.19,
// 60% cached", or the tokens when a model has no price, and without the
// share for records from before it was recorded. On hover, each
// stage's tokens: input with its cached share, output with its reasoning,
// and how full its fullest call's context got.
export function UsageLine({ usage }: { usage: IncidentUsage }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-default items-center gap-1 tabular-nums decoration-dotted underline-offset-4 hover:underline sm:ml-1">
          <CoinsIcon aria-hidden className="size-3.5" />
          {headline(usage)}
        </span>
      </TooltipTrigger>
      {/* Below: above it, the sticky header would cut the table off. */}
      <TooltipContent side="bottom" className="block max-w-none">

        <table className="tabular-nums">
          <thead className="opacity-70">
            <tr>
              <th className="pr-3 text-left font-normal">Stage</th>
              <th className="pr-3 text-right font-normal">Input</th>
              <th className="pr-3 text-right font-normal">Cached</th>
              <th className="pr-3 text-right font-normal">Output</th>
              <th className="pr-3 text-right font-normal">Reasoning</th>
              <th className="pr-3 text-right font-normal">Peak context</th>
              <th className="text-right font-normal">Cost</th>
            </tr>
          </thead>
          <tbody>
            {stageIds.flatMap((id) => {
              const stage = usage.stages[id];
              return stage ? [<StageRow key={id} label={stageLabels[id].label} usage={stage} />] : [];
            })}
            <StageRow label="Total" usage={usage} />
          </tbody>
        </table>
      </TooltipContent>
    </Tooltip>
  );
}

function StageRow({ label, usage: { tokens, cost, detailed, context } }: { label: string; usage: UsageTotal }) {
  return (
    <tr className={label === "Total" ? "font-medium" : undefined}>
      <td className="pr-3">{label}</td>
      <td className="pr-3 text-right">{formatCompact(tokens.inputTokens)}</td>
      <td className="pr-3 text-right">{detailed ? formatPercent(cachedShare(tokens)) : "–"}</td>
      <td className="pr-3 text-right">{formatCompact(tokens.outputTokens)}</td>
      <td className="pr-3 text-right">{detailed ? formatCompact(tokens.reasoningTokens) : "–"}</td>
      <td className="pr-3 text-right">
        {context === undefined ? (
          "–"
        ) : (
          <span className={cn("inline-flex items-center gap-1", toneOf(context))}>
            <ProgressRing value={context} className="size-3" />
            {formatShare(context)}
          </span>
        )}
      </td>
      <td className="text-right">{cost === undefined ? "–" : formatCost(cost)}</td>
    </tr>
  );
}

const headline = ({ tokens, cost, detailed }: UsageTotal) =>
  (cost === undefined ? `${formatCompact(tokens.inputTokens + tokens.outputTokens)} tokens` : formatCost(cost)) +
  (detailed ? `, ${formatPercent(cachedShare(tokens))} cached` : "");
