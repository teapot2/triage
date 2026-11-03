import { saveNewIncident } from "../agent";
import type { DependencyAdvisory, Incident } from "../schema";
import type { TelemetrySource } from "../source";
import {
  dependencyMetric,
  dependencyRuleId,
  dependencyTitle,
  type Finding,
  incidentSeverity,
  severityLabel,
} from "./model";

// The incident a dependency advisory opens: one per advisory per service,
// keyed on its rule id (deps:<service>:<GHSA id>), charting 1 per audit that
// found it against a threshold of 1. Its route is the package, so the
// advisory and the package say what it's about wherever a route is shown.

// How long after a resolution the same advisory coming back reopens the
// incident rather than opening another.
export const REOPEN_DAYS = 30;

export function advisoryOf(f: Finding, at: string, audits: number): DependencyAdvisory {
  return {
    advisoryId: f.advisoryId,
    package: f.package,
    title: f.title,
    versions: f.versions,
    vulnerable: f.vulnerable,
    patched: f.patched,
    severity: f.severity,
    cwe: f.cwe,
    url: f.url,
    dev: f.dev,
    direct: f.direct,
    paths: f.paths,
    audits,
    lastFoundAt: at,
  };
}

export const ruleDescription = (f: Pick<Finding, "package" | "severity" | "dev">) =>
  `${severityLabel(f.severity)} advisory on ${f.dev ? "a dev" : "a runtime"} dependency (${f.package})`;

export async function createDependencyIncident(f: Finding, source: TelemetrySource): Promise<Incident> {
  const metric = dependencyMetric(f.advisoryId);
  const alert = await source.queryMetric({ name: metric, windowMinutes: 7 * 24 * 60 });
  if (!alert || alert.points.length === 0) throw new Error(`No ${metric} series to open an incident from.`);
  const at = alert.points.at(-1)!.t;
  return saveNewIncident(source, alert, {
    title: dependencyTitle(f),
    service: f.service,
    severity: incidentSeverity(f.severity),
    threshold: 1,
    openedBy: "watch",
    rule: { id: dependencyRuleId(f.service, f.advisoryId), name: `${f.advisoryId} in ${f.package}`, description: ruleDescription(f) },
    route: f.package,
    dependency: advisoryOf(f, at, 1),
  });
}

// The incident the advisory coming back should reopen: the newest on its
// rule, resolved within REOPEN_DAYS, not archived. `incidents` is the rule's.
export function dependencyIncidentToReopen(incidents: Incident[], now: number): Incident | undefined {
  return incidents
    .filter((i) => i.status === "resolved" && !i.archivedAt && i.resolvedAt && now - Date.parse(i.resolvedAt) <= REOPEN_DAYS * 86_400_000)
    .sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt))[0];
}
