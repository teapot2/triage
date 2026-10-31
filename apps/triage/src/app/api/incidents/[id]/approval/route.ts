import { after } from "next/server";
import { z } from "zod";
import { decideApproval, openPr } from "@/lib/investigation/approval";
import { rerunFix } from "@/lib/investigation/fix/rerun";
import { shopfrontDir } from "@/lib/investigation/live/live-source";

const bodySchema = z.object({
  decision: z.enum(["approved", "denied"]),
  // Why the fix was denied, and what the next one should do differently.
  feedback: z.string().trim().min(1).max(500).optional(),
  // The approver reviewed the data change; approving a fix that changes
  // stored data needs it.
  dataReviewed: z.boolean().optional(),
});

// Approves or denies the incident's proposed fix and saves the decision.
// Approving a proven fix opens its PR after the response; the incident
// shows the PR's progress. Denying with feedback a fix that can be written
// again starts the fix stage over after the response, with the feedback;
// `rerun` in the response says whether it did. Approving a fix that changes
// stored data is refused (409) unless dataReviewed is true.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: 'expected { decision: "approved" | "denied", feedback?: string, dataReviewed?: boolean } with feedback of 1 to 500 characters' },
      { status: 400 },
    );
  }

  const { id } = await params;
  const result = await decideApproval(id, parsed.data.decision, parsed.data.feedback, parsed.data.dataReviewed);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  if (result.incident.approval?.prState === "opening") after(() => openPr(id, shopfrontDir));
  const rerun = result.rerun === true;
  if (rerun) after(() => rerunFix(id, shopfrontDir));
  return Response.json({ approval: result.incident.approval, status: result.incident.status, rerun });
}
