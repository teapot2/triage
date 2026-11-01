"use client";

import { SplitIcon } from "lucide-react";
import { StatusBadge, type StatusTone } from "@/components/ui/badge";
import type { Fanout } from "@/lib/investigation/schema";
import { modelLabel } from "@/lib/models/labels";
import { cn } from "@/lib/utils";
import { Citations } from "./evidence";
import { LaneTag } from "./lane-tag";
import { laneOfHypothesis } from "./lanes";

type Hypothesis = Fanout["hypotheses"][number];

// A supported hypothesis is a cause, so its dot is the root cause's red;
// a refuted one recedes; an unclear one is still possible, as in the
// verdict's "Still possible".
const findings: Record<NonNullable<Hypothesis["finding"]>, { label: string; tone: StatusTone }> = {
  supported: { label: "Supported", tone: "destructive" },
  refuted: { label: "Refuted", tone: "muted" },
  unclear: { label: "Unclear", tone: "warning" },
};

function FindingBadge({ hypothesis, running }: { hypothesis: Hypothesis; running: boolean }) {
  const finding = hypothesis.finding && findings[hypothesis.finding];
  if (finding) return <StatusBadge tone={finding.tone}>{finding.label}</StatusBadge>;
  // No finding yet: its lane is still checking it, or stopped without one.
  return running ? (
    <StatusBadge tone="muted" loading>
      Checking…
    </StatusBadge>
  ) : (
    <StatusBadge tone="muted">Not checked</StatusBadge>
  );
}

// A fan-out investigation's hypotheses, each checked in its own lane: what
// its lane found, why in a line, and the evidence for and against it. The
// lead model that proposed them merged the findings into the report above.
export function HypothesesChecked({ fanout, running, className }: { fanout: Fanout; running: boolean; className?: string }) {
  if (fanout.hypotheses.length === 0) return null;
  return (
    <div className={cn("flex flex-col gap-3 rounded-lg border p-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-muted-foreground text-xs">
        <span className="flex items-center gap-1.5">
          <SplitIcon className="size-3.5" />
          Hypotheses checked
        </span>
        <span>Merged by {modelLabel(fanout.leadModel, fanout.leadProvider)}</span>
      </div>
      <ul className="flex flex-col divide-y">
        {fanout.hypotheses.map((h, i) => (
          <li key={h.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
            <div className="flex items-start justify-between gap-3">
              <span className="flex min-w-0 items-baseline gap-2">
                <LaneTag lane={laneOfHypothesis(fanout, i)} />
                <span className="font-medium text-sm leading-snug">{h.title}</span>
              </span>
              <FindingBadge hypothesis={h} running={running} />
            </div>
            {(h.reason ?? h.error) && (
              <p className={cn("text-sm leading-relaxed", h.reason ? "text-muted-foreground" : "text-destructive")}>
                {h.reason ?? h.error}
              </p>
            )}
            {(h.evidenceFor.length > 0 || h.evidenceAgainst.length > 0) && (
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs">
                {h.evidenceFor.length > 0 && (
                  <span className="flex items-center gap-1.5">
                    For <Citations ids={h.evidenceFor} />
                  </span>
                )}
                {h.evidenceAgainst.length > 0 && (
                  <span className="flex items-center gap-1.5">
                    Against <Citations ids={h.evidenceAgainst} />
                  </span>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
