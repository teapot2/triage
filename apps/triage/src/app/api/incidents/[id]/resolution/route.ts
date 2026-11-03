import { after } from "next/server";
import { z } from "zod";
import { archivedRefusal, isArchived } from "@/lib/investigation/archive";
import { startDependencyVerification } from "@/lib/investigation/dependencies";
import type { Incident } from "@/lib/investigation/schema";
import { getIncident, patchIncident } from "@/lib/investigation/store";
import { Refused, reopened, resolveRefusal, resolved, startVerification } from "@/lib/investigation/verify";
import { notify } from "@/lib/notifications/notify";

const bodySchema = z.object({
  action: z.enum(["resolve", "reopen", "verify"]),
  note: z.string().max(300).optional(),
});

// A person resolving or reopening the incident by hand, or asking Triage to
// verify it again: a new quiet window from now, watched after the response.
// Not from the last recovery: a breach since then would end the new window
// on the same minute that ended the last one.
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
      // A dependency incident is verified by the audit, which runs now.
      if (incident.dependency) {
        await startDependencyVerification(id, now);
        return Response.json({ status: "verifying" }, { status: 202 });
      }
      const { finished } = await startVerification(id, { after: "manual", since: now });
      after(() => finished);
      return Response.json({ status: "verifying" }, { status: 202 });
    }
    const next = await patchIncident(id, (i): Incident => {
      if (isArchived(i)) throw new Refused(archivedRefusal);
      if (action === "resolve") {
        const refusal = resolveRefusal(i);
        if (refusal) throw new Refused(refusal);
        return resolved(i, now);
      }
      if (i.status !== "resolved") throw new Refused("only a resolved incident can be reopened");
      return reopened(i, { at: now, by: "person", why: note?.trim() || "Reopened by a person" });
    });
    if (action === "resolve") notify("resolved", next);
    return Response.json(action === "resolve" ? { status: next.status, resolvedAt: next.resolvedAt } : { status: next.status });
  } catch (err) {
    if (err instanceof Refused) return Response.json({ error: err.message }, { status: 409 });
    throw err;
  }
}
