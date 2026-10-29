import type { Incident, Question } from "../schema";

// The pure rules around questions, apart from the agent so they can be
// tested without a model.

export const MAX_QUESTION_CHARS = 500;

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

// q_1, q_2, … in the order asked.
export function nextQuestionId(incident: Incident): string {
  const taken = (incident.questions ?? []).map((q) => Number(q.id.slice(2)));
  return `q_${Math.max(0, ...taken) + 1}`;
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
