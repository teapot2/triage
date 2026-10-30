import { connection } from "next/server";
import { z } from "zod";
import {
  builtInSections,
  defaultTemplate,
  isDefaultTemplate,
  sectionId,
  type Template,
} from "@/lib/investigation/postmortem/template";
import { clearTemplate, readTemplate, TemplateError, writeTemplate } from "@/lib/models/settings";

// The team's postmortem template: the sections between the header and the
// Evidence appendix. One for the whole app; each postmortem keeps the
// template it was written with.

const state = (template: Template) => ({ template, isDefault: isDefaultTemplate(template) });

// A custom section may arrive without an id (the page sends new ones by
// name); the server assigns it. The rest is checked by the template schema.
const putSchema = z.object({
  template: z.object({
    sections: z.array(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("builtin"), key: z.enum(builtInSections) }),
        z.object({ kind: z.literal("custom"), id: z.string().optional(), name: z.string(), instructions: z.string() }),
      ]),
    ),
  }),
});

export async function GET() {
  await connection();
  return Response.json(state(await readTemplate()));
}

export async function PUT(req: Request) {
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message));
    return Response.json({ error: problems[0] ?? "invalid template", problems }, { status: 400 });
  }
  // Ids as sent stay; new ones come from the name, apart from every id in use.
  const taken = new Set(parsed.data.template.sections.flatMap((s) => (s.kind === "custom" && s.id ? [s.id] : [])));
  const sections = parsed.data.template.sections.map((s) => {
    if (s.kind === "builtin" || s.id) return s;
    const id = sectionId(s.name, taken);
    taken.add(id);
    return { ...s, id };
  });
  try {
    return Response.json(state(await writeTemplate({ sections } as Template)));
  } catch (err) {
    if (err instanceof TemplateError) {
      return Response.json({ error: err.problems[0] ?? "invalid template", problems: err.problems }, { status: 400 });
    }
    throw err;
  }
}

// Back to the built-in sections.
export async function DELETE() {
  await clearTemplate();
  return Response.json({ template: defaultTemplate, isDefault: true });
}
