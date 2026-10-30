import { after } from "next/server";
import { z } from "zod";
import type { Incident } from "@/lib/investigation/schema";
import { getIncident, patchIncident } from "@/lib/investigation/store";
import { Refused, reopened, resolveRefusal, resolved, startVerification } from "@/lib/investigation/verify";

const bodySchema = z.object({
  action: z.enum(["resolve", "reopen", "verify"]),
  note: z.string().max(300).optional(),
});

// A person resolving or reopening the incident by hand, or asking Triage to
// verify it again: a new quiet window from the last recovery (or from now),
// watched after the response.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'expected { action: "resolve" | "reopen" | "verify", note?: string (up to 300 characters) }' }, { status: 400 });
  }
  const { id } = await params;
  const incident = await getIncident(id);
  if (!incident) return Response.json({ error: `unknown incident: ${id}` }, { status: 404 });

  const { action, note } = parsed.data;
  const now = new Date().toISOString();
  try {
    if (action === "verify") {
      const since = incident.mitigation?.recovery?.recoveredAt ?? now;
      const { finished } = await startVerification(id, { after: "manual", since });
      after(() => finished);
      return Response.json({ status: "verifying" }, { status: 202 });
    }
    const next = await patchIncident(id, (i): Incident => {
      if (action === "resolve") {
        const refusal = resolveRefusal(i);
        if (refusal) throw new Refused(refusal);
        return resolved(i, now);
      }
      if (i.status !== "resolved") throw new Refused("only a resolved incident can be reopened");
      return reopened(i, { at: now, by: "person", why: note?.trim() || "Reopened by a person" });
    });
    return Response.json(action === "resolve" ? { status: next.status, resolvedAt: next.resolvedAt } : { status: next.status });
  } catch (err) {
    if (err instanceof Refused) return Response.json({ error: err.message }, { status: 409 });
    throw err;
  }
}
