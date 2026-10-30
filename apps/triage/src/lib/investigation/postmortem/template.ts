import { z } from "zod";

// A postmortem template: the sections between the header and the Evidence
// appendix, in order. A built-in section is one the renderer knows; a custom
// one is a heading and the instructions the model fills it from.
export const builtInSections = ["summary", "impact", "timeline", "factors", "lessons", "lucky", "actions"] as const;
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
