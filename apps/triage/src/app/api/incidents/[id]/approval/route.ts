import { after } from "next/server";
import { z } from "zod";
import { decideApproval, openPr } from "@/lib/investigation/approval";
import { shopfrontDir } from "@/lib/investigation/live/live-source";

const bodySchema = z.object({ decision: z.enum(["approved", "denied"]) });

// Approves or denies the incident's proposed fix and saves the decision.
// Approving a proven fix opens its PR after the response; the incident
// shows the PR's progress.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'expected { decision: "approved" | "denied" }' }, { status: 400 });

  const { id } = await params;
  const result = await decideApproval(id, parsed.data.decision);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  if (result.incident.approval?.prState === "opening") after(() => openPr(id, shopfrontDir));
  return Response.json({ approval: result.incident.approval, status: result.incident.status });
}
