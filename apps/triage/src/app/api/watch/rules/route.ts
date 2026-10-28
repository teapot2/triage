import { z } from "zod";
import { recheckWatch } from "@/lib/investigation/watch";
import { readRules, rulesSchema, saveRules } from "@/lib/investigation/watch-rules";

// The watch's rules: what it listens for. The defaults until any are saved.
export async function GET() {
  return Response.json({ rules: await readRules() });
}

const bodySchema = z.object({ rules: rulesSchema });

// Replaces the whole list, saved on the server. The watch checks against
// it right away rather than at its next tick.
export async function PUT(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  await saveRules(parsed.data.rules);
  recheckWatch();
  return Response.json({ rules: parsed.data.rules });
}
