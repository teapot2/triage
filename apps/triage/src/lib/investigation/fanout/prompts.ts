import { investigationMethod, prompt, reportRules } from "../agent";
import type { Evidence, Fanout, Incident } from "../schema";
import type { TelemetrySource } from "../source";
import { forModel } from "../tools";
import type { Proposal } from "./tools";

// What each part of a fan-out reads. Hand-offs are the structured parts
// only: evidence as the tools return it (forModel), each hypothesis as the
// scout proposed it, and each lane's finding as it submitted it.
//
// Functions, not constants: agent.ts imports this folder too, so its
// exports aren't ready while the modules load.

export type Hypothesis = Proposal & { id: string };

const intro = "You are Triage, an SRE investigating a production alert for a small team with no SRE.";

export const scoutInstructions = () => `${intro} You survey first: find what looks wrong, then propose the hypotheses worth checking. Each one you propose is checked by its own investigator, in parallel, and you weigh their findings afterwards.

${investigationMethod}

Rules:
- Survey, don't prove: follow steps 1 to 4 broadly. You have up to 8 model calls.
- Cite evidence IDs exactly as tools returned them (ev_metric_1, ev_log_2, ...). Never invent an ID.
- Finish by calling propose_hypotheses with up to 3 hypotheses, most likely first. Make them distinct causes, not one cause in other words. Each says what to test (claim), which services, metrics, logs, files or changes would confirm or refute it (check), and the evidence that raised it.
- If every signal is at baseline, propose none.`;

export const laneInstructions = () => `You are Triage, an SRE checking one hypothesis about a production alert. A survey of the system proposed it; other investigators check the other hypotheses in parallel. Your finding goes to the lead investigator, who writes the report.

Method:
1. Work out what else must be true if the hypothesis holds, and what would be true if it doesn't.
2. Look for evidence against it as hard as for it: timing that doesn't line up, a service that stayed healthy, a change that never touched the code path, an effect that should show elsewhere and doesn't.
3. Start from what the survey found. Where its evidence already answers a question, cite its ID instead of querying again. Make independent queries in the same turn.

Rules:
- Cite evidence IDs exactly as they appear below or as your tools return them. Never invent an ID.
- supported: the evidence shows it and nothing you found contradicts it. refuted: evidence contradicts it. unclear: the evidence can't tell.
- You have up to 8 model calls. Finish by calling submit_finding with the finding, one line saying why, and the evidence IDs for and against it. If it is rejected, fix the listed problems and submit again.`;

export const mergeInstructions = () => `${intro} A survey of the system proposed hypotheses, and each was checked on its own, looking for evidence against it as well as for it. You have all of that evidence and each check's finding: write the report.

- A finding is input, not a vote. Weigh it against the evidence it cites and the rest, and overrule it when the evidence says otherwise.
- The report's hypotheses are yours: keep, merge or add to the checked ones as the evidence calls for.
- Query again only to settle what the evidence leaves open or to cover a service nobody queried. You have up to 6 model calls.

${reportRules}`;

const evidenceLines = (evidence: Evidence[]) =>
  evidence.length ? evidence.map((e) => JSON.stringify(forModel(e))).join("\n") : "(none)";

export const scoutPrompt = (incident: Incident, source: TelemetrySource) =>
  prompt(incident, source, "Survey the system and propose the hypotheses worth checking.");

export function lanePrompt(incident: Incident, source: TelemetrySource, scoutEvidence: Evidence[], h: Hypothesis) {
  // The hypothesis comes last, so every lane's prompt starts the same and
  // shares the prompt cache.
  return prompt(
    incident,
    source,
    `Evidence from the survey:
${evidenceLines(scoutEvidence)}

Hypothesis ${h.id}: ${h.title}
Claim to test: ${h.claim}
What to check: ${h.check.join("; ") || "(not given)"}
Raised by: ${h.evidenceIds.join(", ") || "(no evidence cited)"}

Check this hypothesis and submit your finding.`,
  );
}

// Each checked hypothesis with its finding, for the merge (and the single
// agent when the merge can't finish).
function checkedLines(hypotheses: Fanout["hypotheses"]) {
  return hypotheses
    .map((h) => {
      const outcome = h.error ? `${h.finding ?? "unclear"} (the check failed: ${h.error})` : `${h.finding}: ${h.reason}`;
      return `${h.id}: ${h.title}
  Claim: ${h.claim}
  Finding: ${outcome}
  Evidence for: ${h.evidenceFor.join(", ") || "none"}; against: ${h.evidenceAgainst.join(", ") || "none"}`;
    })
    .join("\n");
}

export function mergePrompt(
  incident: Incident,
  source: TelemetrySource,
  evidence: Evidence[],
  hypotheses: Fanout["hypotheses"],
) {
  const task = hypotheses.length
    ? `Hypotheses checked:\n${checkedLines(hypotheses)}\n\nWeigh the findings against the evidence and submit your report.`
    : "The survey proposed no hypotheses: it found every signal at baseline. Check that against the evidence and submit your report.";
  return prompt(incident, source, `Evidence you may cite, from the survey and every check:\n${evidenceLines(evidence)}\n\n${task}`);
}

// A scout or merge that failed hands its evidence to the single agent,
// which goes on from there; after the merge, with each lane's finding too.
export function fallbackPrompt(
  incident: Incident,
  source: TelemetrySource,
  evidence: Evidence[],
  hypotheses: Fanout["hypotheses"] = [],
) {
  if (!evidence.length && !hypotheses.length) return prompt(incident, source);
  const checked = hypotheses.length
    ? `\n\nHypotheses checked so far, each finding input to weigh, not a verdict:\n${checkedLines(hypotheses)}`
    : "";
  return prompt(
    incident,
    source,
    `Evidence gathered so far, which you may cite:\n${evidenceLines(evidence)}${checked}\n\nInvestigate further as needed and submit your report.`,
  );
}
