import type { InvestigationStep, Thought } from "@/lib/investigation/schema";

// A turn of the step-by-step view: a model call's thinking and the tool
// calls it led to. No thought when it's filtered out or was dropped for
// being empty (its calls then show without one), or for calls made before
// the first recorded thought.
export interface Turn {
  key: string;
  thought?: Thought;
  steps: InvestigationStep[];
  // The steps are known to come from one model call (they carry its ID),
  // so they ran at the same time. Older runs only have the time order.
  together: boolean;
}

// Steps that carry their model call's ID (`turn`) group by it, so a call
// whose thought came back empty is still its own turn. Steps recorded
// before that ID existed fall back to the time order: each belongs to the
// latest thought that started before it (a model call ends, then the tool
// calls it asked for run, then the next call starts). Either way turns are
// cut by every thought, shown or not, so a hidden thought's calls don't
// join the previous one's.
export function groupTurns(all: Thought[], shown: Thought[], steps: InvestigationStep[]): Turn[] {
  const visible = new Set(shown.map((t) => t.id));
  const turns = new Map<string, Turn & { at: number }>();
  const turn = (key: string, at: number, thought?: Thought) => {
    let t = turns.get(key);
    if (!t) {
      t = { key, at, thought: thought && visible.has(thought.id) ? thought : undefined, steps: [], together: false };
      turns.set(key, t);
    }
    return t;
  };
  const starts = all.map((t) => ({ at: Date.parse(t.startedAt), t })).sort((a, b) => a.at - b.at);
  for (const { at, t } of starts) turn(t.id, at, t);
  for (const step of [...steps].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))) {
    const at = Date.parse(step.startedAt);
    if (step.turn) {
      const t = turn(step.turn, at);
      t.steps.push(step);
      t.together = true;
      continue;
    }
    const latest = starts.findLast((s) => s.at <= at);
    turn(latest?.t.id ?? "start", latest?.at ?? -Infinity).steps.push(step);
  }
  return [...turns.values()]
    .sort((a, b) => a.at - b.at)
    .filter((t) => t.thought || t.steps.length > 0)
    .map(({ key, thought, steps, together }) => ({ key, thought, steps, together }));
}

// How a model call's tool calls ran: how many, how long from the first
// start to the last end, and how long they'd have taken one after another.
// No times until every call has finished.
export function turnTiming(steps: InvestigationStep[]): { calls: number; wallMs?: number; serialMs?: number } {
  const calls = steps.length;
  if (calls === 0 || steps.some((s) => s.durationMs === undefined)) return { calls };
  const start = Math.min(...steps.map((s) => Date.parse(s.startedAt)));
  const end = Math.max(...steps.map((s) => Date.parse(s.startedAt) + s.durationMs!));
  return { calls, wallMs: end - start, serialMs: steps.reduce((sum, s) => sum + s.durationMs!, 0) };
}

// The model calls that made tool calls, where the run records them.
export function countTurns(steps: InvestigationStep[]): number | undefined {
  const ids = new Set(steps.flatMap((s) => (s.turn ? [s.turn] : [])));
  return ids.size > 0 ? ids.size : undefined;
}
