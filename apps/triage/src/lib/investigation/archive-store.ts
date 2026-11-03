import { archiveBlocker, isArchived } from "./archive";
import { removeQuestionImages } from "./ask/images";
import { deleteRunSnapshot } from "./live/run-snapshot";
import type { Incident } from "./schema";
import { getIncident, isExample, patchIncident, removeIncident, withIncidentLock } from "./store";

// Archive and restore, each one patch, and permanent delete under the
// incident's lock, so none interleaves with a write in flight (the rules
// are in archive.ts).

export type ArchiveResult = { ok: true; incident: Incident } | { ok: false; status: 404 | 409; error: string };

const unknown = (id: string) => ({ ok: false as const, status: 404 as const, error: `unknown incident: ${id}` });
const refused = (error: string) => ({ ok: false as const, status: 409 as const, error });

// Why it can't be archived, thrown from inside the patch so nothing is saved.
class Refused extends Error {}

// Archives a closed incident. Archiving one already archived answers with
// it as it is, so a second click or a retry is harmless.
export async function archiveIncident(id: string, now = new Date().toISOString()): Promise<ArchiveResult> {
  if (!(await getIncident(id))) return unknown(id);
  try {
    const incident = await patchIncident(id, (i) => {
      if (isArchived(i)) return i;
      const blocker = archiveBlocker(i);
      if (blocker) throw new Refused(blocker);
      return { ...i, archivedAt: now };
    });
    return { ok: true, incident };
  } catch (err) {
    if (err instanceof Refused) return refused(err.message);
    throw err;
  }
}

// Puts the incident back as it was: only `archivedAt` goes, so it returns to
// its place in the list, which is by when it was detected.
export async function restoreIncident(id: string): Promise<ArchiveResult> {
  if (!(await getIncident(id))) return unknown(id);
  // Undefined, so the saved JSON leaves the key out.
  const incident = await patchIncident(id, (i) => (isArchived(i) ? { ...i, archivedAt: undefined } : i));
  return { ok: true, incident };
}

// Deletes an archived incident for good: its record, its question images and
// its run snapshot. Not an active one, and never a bundled example.
export function deleteIncident(id: string): Promise<{ ok: true } | { ok: false; status: 404 | 409; error: string }> {
  return withIncidentLock(id, async () => {
    const incident = await getIncident(id);
    if (!incident) return unknown(id);
    if (isExample(id)) return refused("Example incidents can't be deleted");
    if (!isArchived(incident)) return refused("Archive the incident before deleting it");
    await Promise.all([removeIncident(id), removeQuestionImages(id), deleteRunSnapshot(id)]);
    return { ok: true };
  });
}
