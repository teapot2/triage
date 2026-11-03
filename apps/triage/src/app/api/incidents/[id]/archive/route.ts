import { type ArchiveResult, archiveIncident, restoreIncident } from "@/lib/investigation/archive-store";

// Answers with when the incident was archived, null once restored. Doing
// either twice answers the same, so a retry or a second click is harmless.
const reply = (result: ArchiveResult) =>
  result.ok
    ? Response.json({ archivedAt: result.incident.archivedAt ?? null })
    : Response.json({ error: result.error }, { status: result.status });

// Archives a closed incident: hidden from the lists and read-only until
// restored. 409 with the reason while it can't be (archiveBlocker).
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return reply(await archiveIncident(id));
}

// Restores an archived incident to the lists, as it was.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return reply(await restoreIncident(id));
}
