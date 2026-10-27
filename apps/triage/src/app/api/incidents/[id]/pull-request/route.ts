import { after } from "next/server";
import { openPr, retryPr } from "@/lib/investigation/approval";
import { shopfrontDir } from "@/lib/investigation/live/live-source";

// Retries opening the PR for an approved fix whose PR failed to open.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await retryPr(id);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  after(() => openPr(id, shopfrontDir));
  return Response.json({ approval: result.incident.approval });
}
