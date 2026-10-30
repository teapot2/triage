import type { StageModel } from "../../models/settings";
import { knownEvidenceIds } from "../ask/rules";
import type { Claim, Incident, Postmortem } from "../schema";

// The pure rules around the postmortem, apart from the writer so they can
// be tested without a model.

// What the model submits: the record's judgment, every field required.
export type PostmortemSubmission = Required<
  Pick<Postmortem, "summary" | "impact" | "contributingFactors" | "wentWell" | "wentBadly" | "lucky" | "actionItems">
>;

export const MIN_FACTORS = 2;
export const MAX_FACTORS = 5;

// Why the incident can't have its postmortem written now, or undefined
// when it can: once a report names something wrong, and once nothing that
// would change the story is still running.
export function postmortemRefusal(incident: Incident): string | undefined {
  const { report } = incident;
  if (incident.status === "investigating" || !report) {
    return "the investigation has no report yet: write the postmortem once it has finished";
  }
  if (report.verdict.kind === "healthy") return "a healthy run has nothing to write a postmortem about";
  if (incident.postmortem?.status === "writing") return "the postmortem is already being written: wait for it to finish";
  const fix = incident.fixRun?.status;
  if (fix === "writing" || fix === "testing") return "the fix is still being written: wait for the fix stage to finish";
  const m = incident.mitigation;
  if (m && (m.state === "approved" || m.state === "running" || m.recovery?.status === "watching")) {
    return "the mitigation is still running: wait for the mitigation to finish";
  }
  return undefined;
}

// The record while the model writes it.
export function nextPostmortem(stage: Pick<StageModel, "provider" | "model">, now = new Date()): Postmortem {
  return { status: "writing", startedAt: now.toISOString(), provider: stage.provider, model: stage.model };
}

// Placeholders the tools write where a commit has no known author.
const notNames = new Set(["unknown"]);

// The people the record names: commit authors and whoever decided an
// approval. Lowercase name tokens of 3 letters or more ("Jane Doe
// <jane@x.dev>" is jane and doe).
function peopleTokens(incident: Incident): string[] {
  const names = [
    ...incident.evidence.flatMap((e) => (e.kind === "commit" ? [e.author] : [])),
    ...(incident.questions ?? []).flatMap((q) => q.evidence.flatMap((e) => (e.kind === "commit" ? [e.author] : []))),
    incident.approval?.decidedBy,
    ...(incident.fixAttempts ?? []).map((a) => a.approval.decidedBy),
  ];
  const tokens = names
    .filter((n): n is string => Boolean(n))
    .flatMap((n) => n.replace(/<[^>]*>/g, " ").toLowerCase().split(/[^\p{L}\p{N}]+/u))
    .filter((t) => t.length >= 3 && !notNames.has(t));
  return [...new Set(tokens)];
}

// Phrases that look for someone to blame instead of at the system.
// "blameless" is allowed: it is what the document is.
const blamingPhrases: [RegExp, string][] = [
  [/\bblame(?!less)/i, "blame"],
  [/\bfault of\b/i, "fault of"],
  [/\bshould have\b/i, "should have"],
  [/\bfailed to\b/i, "failed to"],
  [/\bcareless/i, "careless"],
  [/\bnegligen/i, "negligen"],
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// What makes a text not blameless: a person's name, or a blaming phrase.
// One problem per hit.
export function blamelessProblems(text: string, incident: Incident): string[] {
  const problems: string[] = [];
  for (const name of peopleTokens(incident)) {
    if (new RegExp(`(?<![\\p{L}\\p{N}])${escape(name)}(?![\\p{L}\\p{N}])`, "iu").test(text)) {
      problems.push(`names a person ("${name}"): say what shipped or changed, not who did it`);
    }
  }
  for (const [pattern, phrase] of blamingPhrases) {
    if (pattern.test(text)) {
      problems.push(`uses "${phrase}": describe what the system allowed instead of what someone did wrong`);
    }
  }
  return problems;
}

const claimsOf = (s: PostmortemSubmission): Claim[] => [s.impact, ...s.contributingFactors, ...s.wentWell, ...s.wentBadly];

// Every evidence ID the submission cites, in order of first mention.
export function citedEvidenceIds(s: PostmortemSubmission): string[] {
  const ids = [...claimsOf(s).flatMap((c) => c.evidenceIds), ...s.actionItems.flatMap((a) => a.evidenceIds ?? [])];
  return [...new Set(ids)];
}

const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").split(/\s+/).filter(Boolean);

// Whether an action item's title is the incident's fix again (the
// renderer adds the fix as action item 1).
function repeatsFix(title: string, incident: Incident): boolean {
  const t = words(title).join(" ");
  if (t.includes("merge the pr") || t.includes("approve the fix")) return true;
  const start = words(incident.fix?.summary ?? "").slice(0, 5);
  return start.length === 5 && t.includes(start.join(" "));
}

// Rules the tool's schema cannot express; checked on every submission.
export function postmortemProblems(s: PostmortemSubmission, incident: Incident): string[] {
  const problems: string[] = [];
  const n = s.contributingFactors.length;
  if (n < MIN_FACTORS || n > MAX_FACTORS) {
    problems.push(`contributingFactors has ${n}: give ${MIN_FACTORS} to ${MAX_FACTORS}`);
  }
  const known = knownEvidenceIds(incident);
  const unknown = citedEvidenceIds(s).filter((id) => !known.has(id));
  if (unknown.length) problems.push(`unknown evidence IDs cited: ${unknown.join(", ")}. Cite only IDs listed in the prompt`);
  if (/\bev_[a-z0-9_]+/.test(s.summary)) problems.push("the summary cites evidence IDs: write it in plain sentences without them");

  const texts: [string, string][] = [
    ["summary", s.summary],
    ["impact", s.impact.text],
    ...s.contributingFactors.map((c, i): [string, string] => [`contributingFactors[${i}]`, c.text]),
    ...s.wentWell.map((c, i): [string, string] => [`wentWell[${i}]`, c.text]),
    ...s.wentBadly.map((c, i): [string, string] => [`wentBadly[${i}]`, c.text]),
    ...s.lucky.map((t, i): [string, string] => [`lucky[${i}]`, t]),
    ...s.actionItems.map((a, i): [string, string] => [`actionItems[${i}].title`, a.title]),
  ];
  for (const [field, text] of texts) {
    for (const problem of blamelessProblems(text, incident)) problems.push(`${field} ${problem}`);
  }
  s.actionItems.forEach((a, i) => {
    if (repeatsFix(a.title, incident)) {
      problems.push(`actionItems[${i}] repeats the fix ("${a.title}"): it is added separately, list what else to do`);
    }
  });
  return problems;
}
