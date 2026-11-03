import type { StoredFinding } from "@/lib/investigation/dependencies/model";
import { defineDataset } from "../dataset";

// The dependency audit's findings, as the Watch page's Dependencies section
// lists them: what the last audit found, and what it stopped finding in the
// last week (gone_at set). Lists are space-separated, as a version or a
// package name never holds a space.

export const dependencyFindings = defineDataset<StoredFinding>({
  id: "dependency-findings",
  name: "Dependency findings",
  columns: [
    { key: "advisory_id", value: (f) => f.advisoryId },
    { key: "package", value: (f) => f.package },
    { key: "versions", value: (f) => f.versions.join(" ") },
    { key: "patched", value: (f) => f.patched },
    { key: "severity", value: (f) => f.severity },
    { key: "runtime_or_dev", value: (f) => (f.dev ? "dev" : "runtime") },
    { key: "direct", value: (f) => f.direct.join(" ") },
    { key: "first_seen", value: (f) => f.firstSeen },
    { key: "last_seen", value: (f) => f.lastSeen },
    { key: "gone_at", value: (f) => f.goneAt },
    { key: "incident_id", value: (f) => f.incidentId },
  ],
  formats: ["csv", "json"],
});

// The findings the section shows: the current ones, and those gone within
// the week before `now`. GET /api/watch/dependencies keeps the same window.
export const FINDINGS_GONE_DAYS = 7;
export const shownFindings = (findings: StoredFinding[], now: number) =>
  findings.filter((f) => !f.goneAt || Date.parse(f.goneAt) > now - FINDINGS_GONE_DAYS * 86_400_000);
