import { z } from "zod";

// A postmortem template: the sections between the header and the Evidence
// appendix, in order. A built-in section is one the renderer knows; a custom
// one is a heading and the instructions the model fills it from. Outcome
// ("How the diagnosis held up") came later: a saved template from before it
// lacks it, and Settings offers it back as a removed section.
export const builtInSections = ["summary", "impact", "timeline", "outcome", "factors", "lessons", "lucky", "actions"] as const;
export type BuiltInSection = (typeof builtInSections)[number];

export const templateSectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("builtin"), key: z.enum(builtInSections) }),
  z.object({
    kind: z.literal("custom"),
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1).max(60),
    instructions: z.string().min(1).max(500),
  }),
]);
export type TemplateSection = z.infer<typeof templateSectionSchema>;

export const templateSchema = z.object({ sections: z.array(templateSectionSchema).min(1).max(20) });
export type Template = z.infer<typeof templateSchema>;

export const defaultTemplate: Template = { sections: builtInSections.map((key) => ({ kind: "builtin" as const, key })) };

export const builtInLabels: Record<BuiltInSection, string> = {
  summary: "Summary",
  impact: "Impact",
  timeline: "Timeline",
  outcome: "How the diagnosis held up",
  factors: "Contributing factors",
  lessons: "Lessons (what went well and what didn't)",
  lucky: "Where we got lucky",
  actions: "Action items",
};

// How many contributing factors a postmortem lists (rules.ts checks it).
export const MIN_FACTORS = 2;
export const MAX_FACTORS = 5;

// What the writer is told for each built-in section, the record field it
// fills first ("summary: ..."). writer.ts puts them in its prompt; Settings
// shows them, read-only, when a built-in section is opened. The timeline
// has none: the renderer builds it from the record.
export const builtInInstructions: Partial<Record<BuiltInSection, string>> = {
  summary: "summary: three plain sentences, under 80 words, on what happened, the impact and how long it lasted. No evidence IDs.",
  impact: "impact: who was affected and how.",
  outcome:
    "verdictReview: one or two sentences on whether the first diagnosis held, judged only from the Outcome block below: name what confirmed or contradicted it, cite the evidence IDs that block gives. If nothing checked it, say it stands unverified. Never call it confirmed because a fix was written or merged; only a recovered mitigation, a proven regression test or a completed verification confirms it.",
  factors: `contributingFactors: ${MIN_FACTORS} to ${MAX_FACTORS} conditions that each had to hold for the incident to happen, where the evidence supports them: the code path, the input that triggered it, capacity (a pool size, a limit), detection (an alert that was missing or late). When the alert fired on a symptom (latency, errors) and nothing watched the resource that actually ran out (a pool, a queue, a disk), that missing alert is a contributing factor in its own right, cited to the metric evidence that shows the resource saturating.`,
  lessons:
    "wentWell and wentBadly judge detection, response and tooling, never the symptoms themselves: what caught the problem or missed it (an alert on latency but none on the pool), what made the response faster or slower (a flag made the mitigation quick; no test covered the failing path), what tooling helped or was missing. A symptom belongs in impact or the factors, not here.",
  lucky: "lucky: what could have made it worse and did not.",
  actions:
    "actionItems: mix the four kinds (fix_this, prevent_class, detect_sooner, mitigate_faster), with a priority each. Never repeat the fix (\"merge the PR\", \"approve the fix\", or the fix's own words) or the mitigation's steps: both are covered separately. fix_this items are what this instance still needs beyond the fix and the mitigation; if nothing is left, give fewer items rather than restating them.",
};

// A built-in section's instructions as a person reads them: without the
// record field the prompt line starts with.
export const builtInInstructionText = (key: BuiltInSection): string | undefined =>
  builtInInstructions[key]?.replace(/^[a-zA-Z]+: /, "");

export const sectionLabel = (s: TemplateSection) => (s.kind === "builtin" ? builtInLabels[s.key] : s.name);

export type CustomSection = Extract<TemplateSection, { kind: "custom" }>;

// An id for a custom section from its name: lowercase, runs of anything but
// letters and digits as one dash, none at the ends, then -2, -3… while taken.
export function sectionId(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

// What the schema cannot say: no empty list, no built-in section twice, no
// custom id twice. Shape problems (names too long, bad ids) are the schema's.
export function templateProblems(t: Template): string[] {
  const problems: string[] = [];
  if (t.sections.length === 0) problems.push("the template has no sections");
  const keys = new Set<string>();
  const ids = new Set<string>();
  for (const s of t.sections) {
    if (s.kind === "builtin") {
      if (keys.has(s.key)) problems.push(`the built-in section "${s.key}" appears more than once`);
      keys.add(s.key);
    } else {
      if (ids.has(s.id)) problems.push(`the custom section id "${s.id}" appears more than once`);
      ids.add(s.id);
    }
  }
  return problems;
}

export function customSections(t: Template): CustomSection[] {
  return t.sections.filter((s): s is CustomSection => s.kind === "custom");
}

export function keptBuiltIns(t: Template): BuiltInSection[] {
  return t.sections.flatMap((s) => (s.kind === "builtin" ? [s.key] : []));
}

// The same sections, in the same order, as the built-in default.
export function isDefaultTemplate(t: Template): boolean {
  return JSON.stringify(t.sections) === JSON.stringify(defaultTemplate.sections);
}
