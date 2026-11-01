import { tool } from "ai";
import { z } from "zod";
import { type Evidence, evidenceId } from "../schema";

// The fan-out's two finishing tools: the scout's propose_hypotheses and a
// lane's submit_finding. Like submit_report, each is checked, and a
// rejection lists the problems for the model to fix.

export const proposalSchema = z.object({
  hypotheses: z
    .array(
      z.object({
        title: z.string().describe("The suspected cause in a few words"),
        claim: z.string().describe("What to test: the statement that holds if this is the cause"),
        check: z
          .array(z.string())
          .describe("Services, metrics, logs, files or changes that would confirm or refute it"),
        evidenceIds: z.array(evidenceId).describe("The evidence that raised it"),
      }),
    )
    .max(3)
    .describe("0 to 3 distinct hypotheses, most likely first; none if every signal is at baseline"),
});
export type Proposal = z.infer<typeof proposalSchema>["hypotheses"][number];

export const findingSchema = z.object({
  finding: z.enum(["supported", "refuted", "unclear"]),
  reason: z.string().max(300).describe("One line: what the evidence shows about the hypothesis"),
  evidenceFor: z.array(evidenceId).describe("Evidence IDs that support it"),
  evidenceAgainst: z.array(evidenceId).describe("Evidence IDs that contradict it"),
});
export type Finding = z.infer<typeof findingSchema>;

const unknownIds = (cited: string[], known: Evidence[]) => {
  const ids = new Set(known.map((e) => e.id));
  return [...new Set(cited.filter((id) => !ids.has(id)))];
};

// `known` is read at call time: the evidence gathered so far.
export function proposeHypothesesTool(known: () => Evidence[], accept: (hypotheses: Proposal[]) => void) {
  return tool({
    description:
      "Finish the survey: propose up to 3 hypotheses, each to be checked by its own investigator. Propose none if every signal is at baseline. Every cited evidence ID must exist; if it is rejected, fix the listed problems and call it again.",
    inputSchema: proposalSchema,
    execute: async ({ hypotheses }) => {
      const unknown = unknownIds(
        hypotheses.flatMap((h) => h.evidenceIds),
        known(),
      );
      if (unknown.length) return { accepted: false, problems: [`unknown evidence IDs cited: ${unknown.join(", ")}`] };
      accept(hypotheses);
      return { accepted: true };
    },
  });
}

// `known` is what the lane may cite: the scout's evidence and its own.
export function submitFindingTool(known: () => Evidence[], accept: (finding: Finding) => void) {
  return tool({
    description:
      "Submit your finding on the hypothesis: supported, refuted or unclear, one line saying why, and the evidence for and against it. Every cited evidence ID must exist; supported needs evidence for it and refuted evidence against it. If it is rejected, fix the listed problems and submit again.",
    inputSchema: findingSchema,
    execute: async (finding) => {
      const unknown = unknownIds([...finding.evidenceFor, ...finding.evidenceAgainst], known());
      const problems = [
        ...(unknown.length ? [`unknown evidence IDs cited: ${unknown.join(", ")}`] : []),
        ...(finding.finding === "supported" && !finding.evidenceFor.length ? ["a supported finding needs evidenceFor"] : []),
        ...(finding.finding === "refuted" && !finding.evidenceAgainst.length ? ["a refuted finding needs evidenceAgainst"] : []),
      ];
      if (problems.length) return { accepted: false, problems };
      accept(finding);
      return { accepted: true };
    },
  });
}
