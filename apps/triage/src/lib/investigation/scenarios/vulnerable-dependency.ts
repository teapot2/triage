import type { DependencyAdvisory, MetricPoint } from "../schema";
import type { MetricSeries } from "../source";
import { minutesBefore, type Scenario } from "./scenario-source";
import { commonCommits, services } from "./shopfront-base";
import { vulnerableDependencyFiles } from "./vulnerable-dependency-files";

// Shopfront's vulnerable dependency, the fifth fault: release
// shopfront-release/vulnerable-dep ("report the Node runtime and its engines
// check on /api/health") adds semver 7.5.1 as a runtime dependency, used by
// src/lib/runtime.ts, which GET /api/health calls. semver below 7.5.2 has a
// high ReDoS advisory, GHSA-c2qf-rxjj-qqgw, in its range parsing. Nothing
// changes in the traffic: the dependency audit that ran after the deploy
// found it, and that is the alert. The four audits before it found only
// the tree's moderate advisories (glob, minimatch through
// @opentelemetry/auto-instrumentations-node), which open nothing.
//
// What's graded is the exposure stage: it must find the import in
// src/lib/runtime.ts and call it reachable, without blaming anything else.
// The release's range is a constant, so a careful answer also notes no
// request input reaches it; reachable is still the verdict, since the
// vulnerable function runs on every health check.

const now = "2026-11-02T18:04:12.000Z";
const deployedAt = "2026-11-02T17:58:40.000Z";
const advisoryId = "GHSA-c2qf-rxjj-qqgw";

const release = {
  sha: "0338b4a",
  branch: "shopfront-release/vulnerable-dep",
  message: "feat(shopfront): report the Node runtime and its engines check on /api/health",
  files: ["package.json", "src/app/api/health/route.ts", "src/lib/runtime.ts", "src/types/semver.d.ts"],
};

export const vulnerableDependencyAdvisory: DependencyAdvisory = {
  advisoryId,
  package: "semver",
  title: "semver vulnerable to Regular Expression Denial of Service",
  versions: ["7.5.1"],
  vulnerable: ">=7.0.0 <7.5.2",
  patched: ">=7.5.2",
  severity: "high",
  cwe: ["CWE-1333"],
  url: `https://github.com/advisories/${advisoryId}`,
  dev: false,
  direct: ["semver"],
  paths: ["semver"],
  audits: 1,
  lastFoundAt: now,
};

// One audit every 6 h before the deploy, then the Audit now after it.
const audits = [-24, -18, -12, -6].map((h) => minutesBefore(now, -h * 60)).concat(now);
const series = (name: string, description: string, value: (at: string, i: number) => number): MetricSeries => ({
  name,
  service: "shopfront",
  unit: "advisories",
  description,
  points: audits.map((t, i): MetricPoint => ({ t, value: value(t, i) })),
});
const last = audits.length - 1;

export const vulnerableDependency: Scenario = {
  id: "vulnerable-dependency",
  label: "Vulnerable dependency",
  description:
    "A release adds semver 7.5.1, which has a high ReDoS advisory, as a runtime dependency used by the health check. The dependency audit finds it; nothing changes in the traffic.",
  now,
  alert: {
    title: `Vulnerable dependency: semver@7.5.1 (high, ${advisoryId})`,
    service: "shopfront",
    severity: "sev3",
    metric: `vulnerable_dependencies{advisory=${advisoryId}}`,
    threshold: 1,
  },
  dependency: vulnerableDependencyAdvisory,
  services,
  logs: [],
  spans: [],
  metrics: [
    series(
      "vulnerable_dependencies",
      "Advisories the audit of shopfront's runtime dependencies found, one point per audit",
      (_, i) => (i === last ? 3 : 2),
    ),
    series(
      `vulnerable_dependencies{advisory=${advisoryId}}`,
      `1 while the audit finds ${advisoryId} (semver) in shopfront's dependencies, one point per audit`,
      (_, i) => (i === last ? 1 : 0),
    ),
  ],
  db: {
    activity: { query: "", rows: [], note: "A dependency advisory has no database side." },
    locks: { query: "", rows: [], note: "A dependency advisory has no database side." },
    slow_queries: { query: "", rows: [], note: "A dependency advisory has no database side." },
  },
  files: vulnerableDependencyFiles,
  commits: [
    { sha: release.sha, author: "teapot2", message: release.message, files: release.files, committedAt: "2026-11-02T17:41:09.000Z" },
    ...commonCommits(now),
  ],
  deploys: [
    { service: "shopfront", sha: release.sha, kind: "deploy", message: release.message, branch: release.branch, deployedAt },
    { service: "shopfront", sha: "7d02e11", deployedAt: minutesBefore(now, 60 * 21) },
  ],
  expected: {
    verdict: "root_cause",
    rootCauseFiles: ["src/lib/runtime.ts"],
    mustMention: [["semver"], ["7.5.1", "7.5.2", "vulnerable range", advisoryId]],
    mitigation: "none",
    exposure: "reachable",
  },
};
