import { after } from "next/server";
import { z } from "zod";
import { applyMitigation, decideMitigation } from "@/lib/investigation/mitigation/decide";

const bodySchema = z.object({ decision: z.enum(["approved", "denied"]) });

// Approves or denies the incident's proposed mitigation (approving a failed
// one retries it) and saves the decision. Approving runs it after the
// response, then watches the alert recover; the incident shows both.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'expected { decision: "approved" | "denied" }' }, { status: 400 });

  const { id } = await params;
  const result = await decideMitigation(id, parsed.data.decision);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  if (parsed.data.decision === "approved") after(() => applyMitigation(id));
  return Response.json({ mitigation: result.incident.mitigation });
}
