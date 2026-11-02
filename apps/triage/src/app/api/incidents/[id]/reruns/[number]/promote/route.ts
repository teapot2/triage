import { promoteRun, RerunRefused } from "@/lib/investigation/rerun";

// Makes the run the incident's own: its diagnosis, mitigation and fix are
// then the ones to act on, and the run it replaces joins the others.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string; number: string }> }) {
  const { id, number } = await params;
  const n = Number(number);
  if (!Number.isInteger(n) || n < 1) return Response.json({ error: `invalid run: ${number}` }, { status: 400 });
  try {
    const incident = await promoteRun(id, n);
    return Response.json({ runNumber: incident.runNumber });
  } catch (err) {
    if (err instanceof RerunRefused) return Response.json({ error: err.message }, { status: 409 });
    if (err instanceof Error && err.message.startsWith("unknown incident")) return Response.json({ error: err.message }, { status: 404 });
    throw err;
  }
}
