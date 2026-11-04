import type { Incident, Question } from "../schema";
import { sourceKind } from "../source-kind";

// The pure rules around questions, apart from the agent so they can be
// tested without a model.

export const MAX_QUESTION_CHARS = 500;

// An attached image, after the browser has shrunk it (long side 1,600 px,
// WebP): a screenshot lands at 100 to 400 KB. Meta documents a 1 MiB cap on
// a request body, so the image and the prompt fit under it together.
export const MAX_IMAGE_BYTES = 1_000_000;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

// The question an image sent without text asks.
export const DEFAULT_IMAGE_QUESTION = "What does this screenshot show, and does it match the incident?";

// The image's media type from its first bytes, or undefined when it isn't
// one the models take. The browser's type for a file is only its name's.
export function sniffImageType(bytes: Uint8Array): (typeof IMAGE_TYPES)[number] | undefined {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return undefined;
}

// Why the incident can't take a question now, or undefined when it can:
// only once a report exists, and one question at a time.
export function askRefusal(incident: Incident): string | undefined {
  if (incident.status === "investigating" || !incident.report) {
    return "the investigation has no report yet: ask once it has finished";
  }
  const open = incident.questions?.find((q) => q.status === "answering");
  if (open) return `question ${open.id} is still being answered: wait for it to finish`;
  return undefined;
}

// Whether Ask can tell if the alert's metric is back: the record holds the
// recovery watch's or the verification's minutes (ask/after-alert.ts), or
// a mitigation was applied on a live run or an endpoint check, whose tools
// read past the alert (source-for.ts's askSourceFor). A recorded scenario
// or a bundled example without that record has nothing after the alert.
export function knowsAfterAlert(incident: Incident): boolean {
  if (incident.mitigation?.recovery?.series.length || incident.verification?.series.length) return true;
  const kind = sourceKind(incident);
  return incident.mitigation?.state === "applied" && (kind === "live" || kind === "uptime");
}

// q_1, q_2, … in the order asked.
export function nextQuestionId(incident: Incident): string {
  const taken = (incident.questions ?? []).map((q) => Number(q.id.slice(2)));
  return `q_${Math.max(0, ...taken) + 1}`;
}

// The conversation so far, as the model gets it: the last `limit` finished
// questions with their answers, and a failed one with what went wrong, so
// a follow-up like "try again" knows what it follows. An earlier image isn't
// sent again: it's marked, and its answer says what it showed.
export function conversationHistory(questions: Question[], limit: number): string {
  return questions
    .filter((q) => q.status !== "answering")
    .slice(-limit)
    .map(
      (q) =>
        `Q${q.image ? " (with a screenshot)" : ""}: ${q.text}\nA: ${q.status === "failed" ? `(no answer${q.error ? `: ${q.error}` : ""})` : q.answer}`,
    )
    .join("\n\n");
}

// An answer as plain text, for the clipboard: without its evidence
// citations, which mean nothing outside the incident page.
export function plainAnswer(answer: string): string {
  return answer
    .replace(/[ \t]*\[[^\]\n]*\bev_[a-z0-9]+(?:_[a-z0-9]+)*[^\]\n]*\]/g, "")
    .trim();
}

// Every evidence ID an answer on this incident may cite: the
// investigation's and every question's.
export function knownEvidenceIds(incident: Incident, current?: Question): Set<string> {
  const questions = (incident.questions ?? []).filter((q) => q.id !== current?.id);
  return new Set([
    ...incident.evidence.map((e) => e.id),
    ...questions.flatMap((q) => q.evidence.map((e) => e.id)),
    ...(current?.evidence.map((e) => e.id) ?? []),
  ]);
}

const bracketed = /\[([^\]\n]*)\]/g;
const evidenceId = /\bev_[a-z0-9]+(?:_[a-z0-9]+)*/g;

// The evidence IDs an answer cites in square brackets ([ev_log_3], or
// several as [ev_log_3, ev_span_1]), in order of first mention: those that
// exist, and those that don't, which the UI strikes instead of linking.
export function parseCitations(answer: string, known: Set<string>): Pick<Question, "citedIds" | "unknownIds"> {
  const cited = new Set<string>();
  for (const [, inside] of answer.matchAll(bracketed)) {
    for (const [id] of inside.matchAll(evidenceId)) cited.add(id);
  }
  const ids = [...cited];
  return { citedIds: ids.filter((id) => known.has(id)), unknownIds: ids.filter((id) => !known.has(id)) };
}
