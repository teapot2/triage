import type { Incident } from "./schema";

// Archiving takes a closed incident out of everyday view without losing
// anything: Active → Archived → Deleted. Archiving only sets `archivedAt`
// and is undone by restoring; an archived incident is read-only, and hidden
// from the lists, the sidebar, the MCP list and default exports. Deleting
// is permanent, and only for an archived incident. Pure, so the page can
// say why Archive is off without asking the server.

export const archivedRefusal = "Incident is archived; restore it first";

export const isArchived = (incident: Pick<Incident, "archivedAt">) => incident.archivedAt !== undefined;

// Why the incident can't be archived yet, or undefined when it can: only a
// closed incident (resolved, or nothing wrong found) with nothing still
// running on it.
export function archiveBlocker(incident: Incident): string | undefined {
  if (isArchived(incident)) return "The incident is already archived";
  if (incident.status !== "resolved" && incident.status !== "healthy") return "Resolve the incident first";
  if (incident.verification?.status === "verifying") return "Wait for the verification to finish";
  // A mitigation or PR still in flight saves onto the incident when it
  // lands, which would change it after it went read-only.
  const m = incident.mitigation;
  if (m && (m.state === "approved" || m.state === "running" || m.recovery?.status === "watching")) {
    return "Wait for the mitigation to finish";
  }
  if (incident.approval?.prState === "opening") return "Wait for the PR to open";
  if (incident.fixRun?.status === "writing" || incident.fixRun?.status === "testing") return "Wait for the fix test to finish";
  if (incident.reruns?.some((r) => r.status === "investigating")) return "Wait for the re-run to finish";
  if (incident.postmortem?.status === "writing") return "Wait for the postmortem to finish";
  if (incident.questions?.some((q) => q.status === "answering")) return "Wait for the answer to finish";
  return undefined;
}

// Which incidents a list holds: the active ones (the default everywhere),
// every one, or the archived ones alone (Settings → Archived incidents).
export type ArchivedFilter = "exclude" | "include" | "only";

export function filterArchived<T extends Pick<Incident, "archivedAt">>(incidents: T[], archived: ArchivedFilter): T[] {
  if (archived === "include") return incidents;
  return incidents.filter((i) => isArchived(i) === (archived === "only"));
}
