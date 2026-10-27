import { z } from "zod";

// Triage's stages that call a model, each configured with its own provider
// and model in Settings. Safe to import in the browser.

export const stageIds = ["investigate", "fix"] as const;
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
};
