"use client";

import type { StageModel } from "@/components/model-settings";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { leadDefault } from "@/lib/models/stages";

// What "Check hypotheses in parallel" does, opened from Investigate's editor.
// The picture is the explanation: each box says what that step does and on
// which model, as saved now, and a line and two notes say the rest.
export function FanoutExplainer({ lanes, lead }: { lanes: StageModel; lead: StageModel }) {
  const wonder = lead.provider === leadDefault.provider && lead.model === leadDefault.model;
  const leadName = wonder ? "Muse Wonder" : short(lead.model);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="rounded-sm text-foreground text-xs underline underline-offset-4 outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          How it works
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Check hypotheses in parallel</DialogTitle>
          <DialogDescription>Checks up to three possible causes at once, instead of one at a time.</DialogDescription>
        </DialogHeader>

        <figure className="rounded-lg border bg-muted/30 px-3 py-4">
          <RunDiagram leadName={leadName} laneModel={short(lanes.model)} />
        </figure>

        <p className="text-sm">
          {wonder ? (
            "The Lead runs on Muse Wonder, Meta's larger model."
          ) : (
            <>
              The Lead runs on <span className="font-mono">{lead.model}</span>.
            </>
          )}{" "}
          <span className="text-muted-foreground">Change it in its own row under Stages once this is on.</span>
        </p>

        <ul className="flex list-disc flex-col gap-1 pl-5 text-muted-foreground text-xs">
          <li>More model calls per run.</li>
          <li>Falls back to a single agent if the Lead fails.</li>
        </ul>
      </DialogContent>
    </Dialog>
  );
}

// A model ID short enough for a box: its last path segment
// ("accounts/fireworks/models/muse-glimmer-30b" is muse-glimmer-30b), cut at
// 28 characters.
function short(model: string): string {
  const last = model.split("/").pop() ?? model;
  return last.length > 28 ? `${last.slice(0, 27)}…` : last;
}

// The run as one drawing on a fixed 480 × 282 grid, scaled to the dialog's
// width. Colors are the theme's tokens (fill-*, stroke-* classes), so it
// follows light and dark like the rest of the page; the model names are the
// saved ones. The Lead scouts, its three causes are checked side by side in
// one group, and the group's findings go back to the Lead to merge.
function RunDiagram({ leadName, laneModel }: { leadName: string; laneModel: string }) {
  const causes = [80, 240, 400];
  const line = "fill-none stroke-muted-foreground/50";
  return (
    <svg
      viewBox="0 0 480 282"
      className="mx-auto block w-full max-w-[480px] font-sans"
      role="img"
      aria-label={`The Lead (${leadName}) proposes up to 3 causes; each is checked at once on ${laneModel}; the Lead weighs the findings and writes the diagnosis.`}
    >
      {/* Scout to each cause: down, across, down. */}
      <path d={`M240 52 V70 M80 70 H400 ${causes.map((x) => `M${x} 70 V94`).join(" ")}`} className={line} strokeWidth={1.25} />
      {/* The causes, checked together, and their findings back to the Lead. */}
      <rect x={4} y={82} width={472} height={82} rx={10} className="fill-none stroke-border" strokeDasharray="4 4" />
      <path d="M240 164 V184 M240 228 V246" className={line} strokeWidth={1.25} />

      <LeadBox y={8} action="Proposes up to 3 causes" by={`Lead · ${leadName}`} />
      {causes.map((x, i) => (
        <g key={x}>
          <rect x={x - 68} y={94} width={136} height={34} rx={7} className="fill-background stroke-border" />
          <text x={x} y={115} textAnchor="middle" fontSize={12} fontWeight={500} className="fill-foreground">
            Cause {i + 1}
          </text>
        </g>
      ))}
      <text x={240} y={151} textAnchor="middle" fontSize={11} className="fill-muted-foreground">
        Checked at once on{" "}
        <tspan className="font-mono" fontSize={10.5}>
          {laneModel}
        </tspan>
      </text>
      <LeadBox y={184} action="Weighs the findings" by={`Lead · ${leadName}`} />

      <rect x={190} y={246} width={100} height={28} rx={7} className="fill-none stroke-muted-foreground/60" strokeDasharray="3 3" />
      <text x={240} y={264} textAnchor="middle" fontSize={11.5} fontWeight={500} className="fill-foreground">
        Diagnosis
      </text>
    </svg>
  );
}

// A Lead step: what it does, and who does it, in the brand's tint.
function LeadBox({ y, action, by }: { y: number; action: string; by: string }) {
  return (
    <g>
      <rect x={135} y={y} width={210} height={44} rx={8} className="fill-brand/15 stroke-brand/50" />
      <text x={240} y={y + 19} textAnchor="middle" fontSize={12} fontWeight={600} className="fill-foreground">
        {action}
      </text>
      <text x={240} y={y + 35} textAnchor="middle" fontSize={10.5} className="fill-muted-foreground">
        {by}
      </text>
    </g>
  );
}
