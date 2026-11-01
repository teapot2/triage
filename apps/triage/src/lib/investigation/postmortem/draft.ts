import type { DraftContent, PostmortemDraft } from "../schema";
import type { Template, TemplateSection } from "./template";

// The postmortem while it is written: the model's submit_postmortem call,
// parsed as it streams, kept to what can be shown (draftContent), placed in
// the template's sections (writingSection, sectionStates) and revealed a few
// characters at a time on the page (revealDraft). Pure, so the writer and
// the page share it.

// A template section's key: the built-in key, or "custom:" and the id.
export const sectionKey = (s: TemplateSection) => (s.kind === "builtin" ? s.key : `custom:${s.id}`);

// The template section each submission field is written into.
const fieldSections: Record<string, string> = {
  summary: "summary",
  impact: "impact",
  verdictReview: "outcome",
  contributingFactors: "factors",
  wentWell: "lessons",
  wentBadly: "lessons",
  lucky: "lucky",
  actionItems: "actions",
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

const kinds = new Set(["fix_this", "prevent_class", "detect_sooner", "mitigate_faster"]);
const priorities = new Set(["P1", "P2", "P3"]);

// The partial submission (JSON cut off anywhere, closed by a partial JSON
// parser) as draft content: strings where strings belong, evidence IDs only
// once they are known ones (a cut-off "ev_log_1" may become ev_log_12),
// custom sections only once their id names one of the template's. Never
// throws.
export function draftContent(partial: unknown, known: Set<string>, template: Template): DraftContent {
  if (!isObject(partial)) return {};
  const ids = (v: unknown) => strings(v).filter((id) => known.has(id));
  const claim = (v: unknown) => (isObject(v) && typeof v.text === "string" ? { text: v.text, evidenceIds: ids(v.evidenceIds) } : undefined);
  const claims = (v: unknown) => (Array.isArray(v) ? v.map(claim).filter((c) => c !== undefined) : undefined);
  const customIds = new Set(template.sections.flatMap((s) => (s.kind === "custom" ? [s.id] : [])));

  const out: DraftContent = {};
  if (typeof partial.summary === "string") out.summary = partial.summary;
  const impact = claim(partial.impact);
  if (impact) out.impact = impact;
  const verdictReview = claim(partial.verdictReview);
  if (verdictReview) out.verdictReview = verdictReview;
  for (const field of ["contributingFactors", "wentWell", "wentBadly"] as const) {
    const list = claims(partial[field]);
    if (list) out[field] = list;
  }
  if (Array.isArray(partial.lucky)) out.lucky = strings(partial.lucky);
  if (Array.isArray(partial.actionItems)) {
    out.actionItems = partial.actionItems.filter(isObject).flatMap((item) =>
      typeof item.title === "string"
        ? [
            {
              title: item.title,
              kind: kinds.has(item.kind as string) ? (item.kind as never) : undefined,
              priority: priorities.has(item.priority as string) ? (item.priority as never) : undefined,
              evidenceIds: ids(item.evidenceIds),
            },
          ]
        : [],
    );
  }
  if (Array.isArray(partial.custom)) {
    out.custom = partial.custom
      .filter(isObject)
      .flatMap((c) =>
        typeof c.id === "string" && customIds.has(c.id) ? [{ id: c.id, text: typeof c.text === "string" ? c.text : "", evidenceIds: ids(c.evidenceIds) }] : [],
      );
  }
  return out;
}

// The section the model is writing into: the one its last field belongs to,
// in the order the JSON came (the custom list's last entry for custom).
// Undefined before it has written any.
export function writingSection(partial: unknown): string | undefined {
  if (!isObject(partial)) return undefined;
  const last = Object.keys(partial).at(-1);
  if (last === undefined) return undefined;
  if (last === "custom") {
    const entry = Array.isArray(partial.custom) ? partial.custom.at(-1) : undefined;
    return isObject(entry) && typeof entry.id === "string" ? `custom:${entry.id}` : undefined;
  }
  return fieldSections[last];
}

// Whether the model has started a section: its field is there, even if it
// is an empty list (nothing went lucky). The timeline is the renderer's,
// never the model's; the outcome is the renderer's facts with the model's
// sentence under them, started once that sentence is.
export function sectionStarted(content: DraftContent, key: string): boolean {
  switch (key) {
    case "summary":
      return content.summary !== undefined;
    case "impact":
      return content.impact !== undefined;
    case "outcome":
      return content.verdictReview !== undefined;
    case "factors":
      return content.contributingFactors !== undefined;
    case "lessons":
      return content.wentWell !== undefined || content.wentBadly !== undefined;
    case "lucky":
      return content.lucky !== undefined;
    case "actions":
      return content.actionItems !== undefined;
    case "timeline":
      return false;
    default:
      return Boolean(content.custom?.some((c) => `custom:${c.id}` === key));
  }
}

export type SectionState = "done" | "writing" | "pending";

// Each template section's state, by key, around the cursor `at` (from
// revealDraft): done above it, pending below, all done without one.
export function sectionStates(template: Template, at: string | undefined): Map<string, SectionState> {
  const keys = template.sections.map(sectionKey);
  const cursor = at === undefined ? keys.length : Math.max(0, keys.indexOf(at));
  return new Map(keys.map((key, i): [string, SectionState] => [key, i < cursor ? "done" : i === cursor ? "writing" : "pending"]));
}

// How far the submission has come: `open` is the section whose field is
// still being written (draft.writing), `complete` that the whole submission
// is in (a ready postmortem, or a draft whose JSON closed).
export interface Progress {
  open: string | undefined;
  complete: boolean;
}

// A draft's progress: the JSON closes when the server stops naming an open
// section after something was written.
export const progressOf = (draft: PostmortemDraft): Progress => ({
  open: draft.writing,
  complete: draft.writing === undefined && Object.keys(draft.content).length > 0,
});

const whole: Progress = { open: undefined, complete: true };

// Characters of text the draft can show: what revealDraft counts.
export function draftLength(content: DraftContent, template: Template, progress = whole): number {
  return revealDraft(content, template, Infinity, progress).used;
}

// The draft as the page shows it: its first `budget` characters of text,
// read in the template's order, top down, the way a document is written.
// A section shows once every one above it is finished: a model that writes
// its fields in another order (Meta's sorts them) still fills the page
// from the top. Until the submission is complete, the reading stops at a
// section not started yet and at the open one. Evidence IDs, kinds and
// priorities cost nothing; a claim or item cut short shows them once its
// text is whole. `at` is where the reading stopped (the cursor), undefined
// once everything is shown.
export function revealDraft(
  content: DraftContent,
  template: Template,
  budget: number,
  progress = whole,
): { content: DraftContent; at: string | undefined; used: number } {
  let left = budget;
  let at: string | undefined;
  let used = 0;
  // The text that fits, marking where the cut fell.
  const take = (key: string, text: string): string | undefined => {
    if (at !== undefined) return undefined;
    if (text.length <= left) {
      left -= text.length;
      used += text.length;
      return text;
    }
    at = key;
    used += left;
    const cut = text.slice(0, left);
    left = 0;
    return cut;
  };
  const claim = (key: string, c: { text: string; evidenceIds: string[] }) => {
    const text = take(key, c.text);
    return text === undefined ? undefined : { text, evidenceIds: text === c.text ? c.evidenceIds : [] };
  };
  const claims = (key: string, list: { text: string; evidenceIds: string[] }[] | undefined) =>
    list && at === undefined ? list.map((c) => claim(key, c)).filter((c) => c !== undefined) : undefined;

  const out: DraftContent = {};
  for (const section of template.sections) {
    const key = sectionKey(section);
    if (at !== undefined) break;
    if (key !== "timeline" && !sectionStarted(content, key)) {
      // A complete submission without it: the model left it out.
      if (progress.complete) continue;
      at = key;
      break;
    }
    if (section.kind === "custom") {
      const written = content.custom?.find((c) => c.id === section.id);
      const c = written && claim(key, written);
      if (c) out.custom = [...(out.custom ?? []), { id: section.id, ...c }];
    } else {
      switch (section.key) {
        case "summary":
          if (content.summary !== undefined) out.summary = take(key, content.summary);
          break;
        case "impact":
          if (content.impact) out.impact = claim(key, content.impact);
          break;
        case "outcome":
          if (content.verdictReview) out.verdictReview = claim(key, content.verdictReview);
          break;
        case "factors":
          out.contributingFactors = claims(key, content.contributingFactors);
          break;
        case "lessons":
          out.wentWell = claims(key, content.wentWell);
          out.wentBadly = claims(key, content.wentBadly);
          break;
        case "lucky":
          if (content.lucky) out.lucky = content.lucky.map((s) => take(key, s)).filter((s) => s !== undefined);
          break;
        case "actions":
          if (content.actionItems) {
            out.actionItems = content.actionItems.flatMap((item) => {
              const title = take(key, item.title);
              if (title === undefined) return [];
              // Its kind and priority, like citations, once the title is whole.
              return [title === item.title ? item : { title, evidenceIds: [] }];
            });
          }
          break;
      }
    }
    // The open section: shown as far as it has come, and nothing below it.
    if (at === undefined && !progress.complete && key === progress.open) at = key;
  }
  // Undefined fields out, so the result reads like a draft that arrived so.
  for (const k of Object.keys(out) as (keyof DraftContent)[]) if (out[k] === undefined) delete out[k];
  return { content: out, at, used };
}

// A new draft for the next submission: empty, keeping why the last one
// was rejected.
export function nextAttempt(draft: PostmortemDraft | undefined, problems?: string[]): PostmortemDraft {
  return { attempt: (draft?.attempt ?? 0) + 1, content: {}, ...(problems?.length ? { problems } : {}) };
}
