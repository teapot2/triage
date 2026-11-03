import { z } from "zod";

// The dependency audit's model: what the watched service's package manager
// reports as vulnerable, each audit's outcome, and the settings. No server
// imports, so the Watch page can use it too; running an audit is audit.ts,
// saving it store.ts, the loop ../dependencies.ts.

export const severities = ["info", "low", "moderate", "high", "critical"] as const;
export const severitySchema = z.enum(severities);
export type AdvisorySeverity = z.infer<typeof severitySchema>;

export const severityRank = (s: AdvisorySeverity) => severities.indexOf(s);
export const atLeast = (s: AdvisorySeverity, floor: AdvisorySeverity) => severityRank(s) >= severityRank(floor);

// The floors a person can pick: below moderate is noise for an incident.
export const severityFloors = ["moderate", "high", "critical"] as const;
export type SeverityFloor = (typeof severityFloors)[number];

export const packageManagers = ["pnpm", "npm"] as const;
export type PackageManager = (typeof packageManagers)[number];

// One advisory as it affects the service: every version of the package its
// tree holds, and the chains that pull it in, read from the service's own
// root (the importer's prefix is dropped). `direct` is the service's own
// dependency at the head of each chain; `dev` is true when every chain
// starts at a devDependency, so the package never runs in production.
export const findingSchema = z.object({
  // The GHSA id, or "npm-<id>" for an advisory without one.
  advisoryId: z.string().min(1),
  service: z.string().min(1),
  package: z.string().min(1),
  title: z.string(),
  versions: z.array(z.string()).min(1),
  vulnerable: z.string(),
  // Missing when no fixed version is published.
  patched: z.string().optional(),
  severity: severitySchema,
  cwe: z.array(z.string()),
  url: z.string(),
  dev: z.boolean(),
  direct: z.array(z.string()),
  paths: z.array(z.string()),
});
export type Finding = z.infer<typeof findingSchema>;

// A finding as kept across audits: when it was first and last found, the
// incident it opened, and when an audit stopped finding it.
export const storedFindingSchema = findingSchema.extend({
  firstSeen: z.iso.datetime(),
  lastSeen: z.iso.datetime(),
  incidentId: z.string().optional(),
  goneAt: z.iso.datetime().optional(),
});
export type StoredFinding = z.infer<typeof storedFindingSchema>;

export type SeverityCounts = Record<AdvisorySeverity, number>;
export const noCounts = (): SeverityCounts => ({ info: 0, low: 0, moderate: 0, high: 0, critical: 0 });

// One audit: when, how long, what it found by severity (runtime and dev
// together), or why it couldn't run. A failed audit keeps the previous
// findings: it's a fact to show, not a clean bill of health.
export const auditSchema = z.object({
  id: z.number().int().optional(),
  service: z.string(),
  at: z.iso.datetime(),
  durationMs: z.number().int().nonnegative(),
  packageManager: z.enum(packageManagers).optional(),
  counts: z.record(severitySchema, z.number().int().nonnegative()),
  runtime: z.number().int().nonnegative(),
  error: z.string().optional(),
});
export type Audit = z.infer<typeof auditSchema>;

export const MIN_INTERVAL_HOURS = 1;
export const MAX_INTERVAL_HOURS = 24;
export const intervalChoices = [1, 3, 6, 12, 24] as const;

export const dependencySettingsSchema = z.object({
  enabled: z.boolean().default(true),
  intervalHours: z.number().int().min(MIN_INTERVAL_HOURS).max(MAX_INTERVAL_HOURS).default(6),
  severityFloor: z.enum(severityFloors).default("high"),
  // The service's checkout, when it isn't Shopfront's (SHOPFRONT_DIR).
  serviceDir: z.string().max(1000).optional(),
});
export type DependencySettings = z.infer<typeof dependencySettingsSchema>;
export const defaultDependencySettings = (): DependencySettings => dependencySettingsSchema.parse({});

// What opens an incident: a runtime dependency at or over the floor.
export const opensIncident = (f: Pick<Finding, "dev" | "severity">, floor: SeverityFloor) => !f.dev && atLeast(f.severity, floor);

// critical → sev2, high and below → sev3: a dependency incident is quieter
// than an outage in Slack and on the board.
export const incidentSeverity = (s: AdvisorySeverity): "sev2" | "sev3" => (s === "critical" ? "sev2" : "sev3");

// The incident's rule id: one incident per advisory per service.
export const dependencyRuleId = (service: string, advisoryId: string) => `deps:${service}:${advisoryId}`;

// The trigger's series: advisories found per audit.
export const DEPENDENCY_METRIC = "vulnerable_dependencies";
export const dependencyMetric = (advisoryId: string) => `${DEPENDENCY_METRIC}{advisory=${advisoryId}}`;
export const DEPENDENCY_UNIT = "advisories";

export const dependencyTitle = (f: Pick<Finding, "package" | "versions" | "severity" | "advisoryId">) =>
  `Vulnerable dependency: ${f.package}@${f.versions[0]} (${f.severity}, ${f.advisoryId})`;

// "high" → "High".
export const severityLabel = (s: AdvisorySeverity) => s.charAt(0).toUpperCase() + s.slice(1);
