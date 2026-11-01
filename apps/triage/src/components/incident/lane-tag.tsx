import type { Fanout } from "@/lib/investigation/schema";
import { laneLabel, laneTitle } from "./lanes";

// Which lane of a fan-out run something came from ("H1"), as a small fixed
// width tag so a column of them lines up. Hover names the hypothesis.
export function LaneTag({ lane, fanout }: { lane: string; fanout?: Fanout }) {
  return (
    <span
      title={laneTitle(lane, fanout)}
      className="inline-flex h-4 w-10 shrink-0 items-center justify-center rounded bg-muted font-sans font-normal text-[10px] text-muted-foreground"
    >
      {laneLabel(lane)}
    </span>
  );
}
