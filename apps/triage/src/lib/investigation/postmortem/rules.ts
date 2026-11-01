import type { StageModel } from "../../models/settings";
import { recordedEffort } from "../../models/stages";
import { knownEvidenceIds } from "../ask/rules";
import { type OutcomeRollup, rollupLabels, type VerdictOutcome, verdictOutcome } from "../outcome";
import type { Claim, Incident, Postmortem } from "../schema";
import { customSections, keptBuiltIns, type Template } from "./template";

// The pure rules around the postmortem, apart from the writer so they can
// be tested without a model.

// What the model submits: the judgment of the sections the template keeps,
// each field required there and absent where the section was dropped, and
// the custom sections' texts by id.
export type PostmortemSubmission = Partial<
  Required<
    Pick<
      Postmortem,
      "summary" | "impact" | "verdictReview" | "contributingFactors" | "wentWell" | "wentBadly" | "lucky" | "actionItems"
    >
  >
> & { custom?: { id: string; text: string; evidenceIds: string[] }[] };

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
export function nextPostmortem(stage: Pick<StageModel, "provider" | "model" | "effort">, now = new Date()): Postmortem {
  return {
    status: "writing",
    startedAt: now.toISOString(),
    provider: stage.provider,
    model: stage.model,
    reasoningEffort: recordedEffort(stage),
  };
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

const claimsOf = (s: PostmortemSubmission): Claim[] => [
  ...(s.impact ? [s.impact] : []),
  ...(s.verdictReview ? [s.verdictReview] : []),
  ...(s.contributingFactors ?? []),
  ...(s.wentWell ?? []),
  ...(s.wentBadly ?? []),
  ...(s.custom ?? []),
];

// Every evidence ID the submission cites, in order of first mention.
export function citedEvidenceIds(s: PostmortemSubmission): string[] {
  const ids = [...claimsOf(s).flatMap((c) => c.evidenceIds), ...(s.actionItems ?? []).flatMap((a) => a.evidenceIds ?? [])];
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

// Words that say the diagnosis held. "Right" only as "got it right" or
// "was right": "the right side" says nothing about it.
const saysItHeld = /\b(?:confirmed|correct|held|validated)\b|\b(?:got it|was) right\b/i;
// A negation and the three words after it: "nothing confirmed it", "was not
// validated", "hasn't held". Taken out before testing for saysItHeld.
const negated = /\b(?:not|never|nothing|no|nobody|none|without|\w+n't)\b(?:\W+[\w']+){1,3}/gi;
const notConfirmed = new Set<OutcomeRollup>(["contradicted", "unverified"]);

// A verdict review that says the diagnosis held when the record says it was
// contradicted or never checked. Triage doesn't get to grade itself: the
// outcome is computed from the record (outcome.ts), and the review has to
// agree with it. A review that names the actual outcome ("it stands
// unverified") or says it held only under a negation ("nothing confirmed
// it") says so in its own words.
export function outcomeProblems(s: PostmortemSubmission, outcome: VerdictOutcome | undefined): string[] {
  const text = s.verdictReview?.text.trim();
  if (!text || !outcome || !notConfirmed.has(outcome.rollup)) return [];
  const actual = rollupLabels[outcome.rollup].toLowerCase();
  if (!saysItHeld.test(text.replace(negated, " ")) || new RegExp(`\\b${actual}\\b`, "i").test(text)) return [];
  const quoted = text.length > 80 ? `${text.slice(0, 80)}…` : text;
  return [`verdictReview says the diagnosis held ("${quoted}"), but the record shows it ${actual}: say what the Outcome block shows.`];
}

// Rules the tool's schema cannot express; checked on every submission, only
// for the sections the template keeps. The outcome is the record's
// (verdictOutcome); the writer passes the one its prompt showed.
export function postmortemProblems(
  s: PostmortemSubmission,
  incident: Incident,
  template: Template,
  outcome: VerdictOutcome | undefined = verdictOutcome(incident),
): string[] {
  const problems: string[] = [];
  const kept = new Set(keptBuiltIns(template));
  if (kept.has("factors")) {
    const n = s.contributingFactors?.length ?? 0;
    if (n < MIN_FACTORS || n > MAX_FACTORS) {
      problems.push(`contributingFactors has ${n}: give ${MIN_FACTORS} to ${MAX_FACTORS}`);
    }
  }
  const wanted = customSections(template).map((c) => c.id);
  const seen = new Map<string, number>();
  for (const c of s.custom ?? []) seen.set(c.id, (seen.get(c.id) ?? 0) + 1);
  for (const id of wanted) {
    const count = seen.get(id) ?? 0;
    if (count === 0) problems.push(`custom section "${id}" is missing: write it once`);
    else if (count > 1) problems.push(`custom section "${id}" appears ${count} times: write it once`);
  }
  for (const id of seen.keys()) {
    if (!wanted.includes(id)) problems.push(`custom section "${id}" is not in the template: write only ${wanted.length ? wanted.join(", ") : "none"}`);
  }

  if (kept.has("outcome")) problems.push(...outcomeProblems(s, outcome));

  const known = knownEvidenceIds(incident);
  const unknown = citedEvidenceIds(s).filter((id) => !known.has(id));
  if (unknown.length) problems.push(`unknown evidence IDs cited: ${unknown.join(", ")}. Cite only IDs listed in the prompt`);
  if (s.summary !== undefined && /\bev_[a-z0-9_]+/.test(s.summary)) {
    problems.push("the summary cites evidence IDs: write it in plain sentences without them");
  }

  const texts: [string, string][] = [
    ...(s.summary !== undefined ? [["summary", s.summary] as [string, string]] : []),
    ...(s.impact ? [["impact", s.impact.text] as [string, string]] : []),
    ...(s.verdictReview ? [["verdictReview", s.verdictReview.text] as [string, string]] : []),
    ...(s.contributingFactors ?? []).map((c, i): [string, string] => [`contributingFactors[${i}]`, c.text]),
    ...(s.wentWell ?? []).map((c, i): [string, string] => [`wentWell[${i}]`, c.text]),
    ...(s.wentBadly ?? []).map((c, i): [string, string] => [`wentBadly[${i}]`, c.text]),
    ...(s.lucky ?? []).map((t, i): [string, string] => [`lucky[${i}]`, t]),
    ...(s.actionItems ?? []).map((a, i): [string, string] => [`actionItems[${i}].title`, a.title]),
    ...(s.custom ?? []).map((c): [string, string] => [`custom "${c.id}"`, c.text]),
  ];
  for (const [field, text] of texts) {
    for (const problem of blamelessProblems(text, incident)) problems.push(`${field} ${problem}`);
  }
  (s.actionItems ?? []).forEach((a, i) => {
    if (repeatsFix(a.title, incident)) {
      problems.push(`actionItems[${i}] repeats the fix ("${a.title}"): it is added separately, list what else to do`);
    }
  });
  return problems;
}
