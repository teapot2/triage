import type { Fanout, InvestigationStep, Thought } from "@/lib/investigation/schema";

// The lanes of a fan-out investigation, as the timeline names them: the
// scout that proposes hypotheses, one lane per hypothesis (h1 to h3) and
// the merge that writes the report. Single-agent runs have none.

// Scout first, then the hypotheses by number, then the merge; anything
// else after them, by name.
function rank(lane: string): [number, number] {
  if (lane === "scout") return [0, 0];
  const h = /^h(\d+)$/.exec(lane);
  if (h) return [1, Number(h[1])];
  if (lane === "merge") return [2, 0];
  return [3, 0];
}

export function compareLanes(a: string, b: string): number {
  const [ga, na] = rank(a);
  const [gb, nb] = rank(b);
  return ga - gb || na - nb || a.localeCompare(b);
}

// "Scout", "H1", "Merge".
export function laneLabel(lane: string): string {
  if (lane === "scout") return "Scout";
  if (lane === "merge") return "Merge";
  if (/^h\d+$/.test(lane)) return lane.toUpperCase();
  return lane;
}

// What a lane did, for its label's hover: the hypothesis it checked, or the
// lead model's part. The hypothesis is the one with the lane's ID, else the
// lane's number in the list.
export function laneTitle(lane: string, fanout?: Fanout): string | undefined {
  if (lane === "scout") return "Scout: proposes the hypotheses";
  if (lane === "merge") return "Merge: writes the report from the findings";
  const h = /^h(\d+)$/.exec(lane);
  if (!h) return undefined;
  const hypothesis = fanout?.hypotheses.find((x) => x.id === lane) ?? fanout?.hypotheses[Number(h[1]) - 1];
  return hypothesis ? `${laneLabel(lane)}: ${hypothesis.title}` : undefined;
}

// The hypothesis a lane checked, by the same rule.
export function laneOfHypothesis(fanout: Fanout, index: number): string {
  const id = fanout.hypotheses[index].id;
  return /^h\d+$/.test(id) ? id : `h${index + 1}`;
}

// Each lane in the run, in lane order, with how many thoughts and tool
// calls it has. Empty for a single-agent run.
export function laneOptions(steps: InvestigationStep[], thoughts: Thought[]): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const { lane } of [...thoughts, ...steps]) if (lane) counts.set(lane, (counts.get(lane) ?? 0) + 1);
  return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => compareLanes(a.value, b.value));
}
