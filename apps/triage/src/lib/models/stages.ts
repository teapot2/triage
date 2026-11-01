import { z } from "zod";

// Triage's stages that call a model, each configured with its own provider
// and model in Settings. Safe to import in the browser.

export const stageIds = ["investigate", "lead", "fix", "ask", "postmortem"] as const;
export const stageIdSchema = z.enum(stageIds);
export type StageId = z.infer<typeof stageIdSchema>;

export const stageLabels: Record<StageId, { label: string; description: string }> = {
  investigate: {
    label: "Investigate",
    description: "Reads the telemetry, database and code, and writes the diagnosis. Needs tool calling.",
  },
  lead: {
    label: "Lead",
    description: "With hypotheses checked in parallel, proposes them and merges the checks' findings into the diagnosis.",
  },
  fix: {
    label: "Fix",
    description: "Writes the patch and its regression test, retrying until the sandbox proves them.",
  },
  ask: {
    label: "Ask",
    description: "Answers follow-up questions on an incident with the investigation's tools.",
  },
  postmortem: {
    label: "Postmortem",
    description: "Writes the blameless postmortem from the incident's record. No tools.",
  },
};

// A stage with nothing saved uses the model this one has, until changed in
// Settings: Ask answers with the Investigate stage's model, and the
// Postmortem with Ask's (so Investigate's, when Ask has none either).
export const stageFallback: Partial<Record<StageId, StageId>> = { ask: "investigate", postmortem: "ask" };

// The Lead (a fan-out's scout and merge) starts on Wonder rather than the
// env's model: proposing and weighing hypotheses is where the bigger model
// pays for itself, over a few calls.
export const leadDefault = { provider: "meta", model: "muse-wonder-1.0" } as const;

// How hard Meta's models think before answering (the Responses API's
// reasoning.effort). Other providers ignore it. "none" is left out: every
// Meta model answers it with a 400.
export const reasoningEfforts = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const reasoningEffortSchema = z.enum(reasoningEfforts);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export const effortLabels: Record<ReasoningEffort, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

// A stage's effort until changed in Settings. Not inherited down the
// fallback chain: a Postmortem on Ask's model still thinks at its own level.
export const defaultEffort: Record<StageId, ReasoningEffort> = {
  investigate: "high",
  lead: "high",
  fix: "high",
  ask: "low",
  postmortem: "medium",
};

// The effort to record on a run: only Meta's API takes one, so a run on
// another provider records none rather than a setting it ignored.
export const recordedEffort = (s: { provider: string; effort?: ReasoningEffort }) =>
  s.provider === "meta" ? s.effort : undefined;

// The levels a model takes. Spark 1.1 and 1.2 answer "max" with a 400
// (tried October 2026); Spark 1.3 and Wonder take every level.
export const effortsFor = (model: string): readonly ReasoningEffort[] =>
  /^muse-spark-1\.[0-2](\D|$)/.test(model) ? reasoningEfforts.filter((e) => e !== "max") : reasoningEfforts;
