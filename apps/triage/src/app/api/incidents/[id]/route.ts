import { deleteIncident } from "@/lib/investigation/archive-store";

// Deletes an archived incident for good: its record, question images and
// run snapshot. 409 for one that isn't archived, and for a bundled example.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await deleteIncident(id);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ deleted: true });
}
