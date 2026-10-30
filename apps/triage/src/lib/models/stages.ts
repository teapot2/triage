import { z } from "zod";

// Triage's stages that call a model, each configured with its own provider
// and model in Settings. Safe to import in the browser.

export const stageIds = ["investigate", "fix", "ask", "postmortem"] as const;
export const stageIdSchema = z.enum(stageIds);
export type StageId = z.infer<typeof stageIdSchema>;

export const stageLabels: Record<StageId, { label: string; description: string }> = {
  investigate: {
    label: "Investigate",
    description: "Reads the telemetry, database and code, and writes the diagnosis. Needs tool calling.",
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
