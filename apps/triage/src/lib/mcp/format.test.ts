import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { citationOrder } from "../investigation/citations";
import { exposureReport } from "../investigation/dependencies/exposure";
import type { StoredFinding } from "../investigation/dependencies/model";
import { exampleIncidents } from "../investigation/fixtures";
import { toSummary } from "../investigation/list-summary";
import type { Evidence, Incident, Question } from "../investigation/schema";
import {
  answerMarkdown,
  CODE_LINES,
  citedEvidence,
  DB_ROWS,
  dependencyFindingsMarkdown,
  downsample,
  evidenceMarkdown,
  fixMarkdown,
  incidentListMarkdown,
  incidentMarkdown,
  incidentRow,
  SERIES_POINTS,
} from "./format";

const base = "http://localhost:3000";
const example = (id: string): Incident => structuredClone(exampleIncidents.find((i) => i.id === id)!);

describe("incidentMarkdown", () => {
  it("gives the pool leak's verdict, causal chain and a line per cited item", () => {
    const incident = example("inc_pool_leak");
    const md = incidentMarkdown(incident, base);
    assert.match(md, /^# /);
    assert.match(md, /Page: http:\/\/localhost:3000\/incidents\/inc_pool_leak/);
    assert.match(md, /Root cause: \*\*/);
    for (const part of ["- Symptom: ", "- Propagation: ", "- Root cause: "]) assert.ok(md.includes(part), part);
    for (const id of citationOrder(incident.report!)) assert.ok(md.includes(`- [${id}] `), `cited line for ${id}`);
    assert.match(md, /## Also considered/);
    assert.match(md, /get_fix/);
    assert.ok(!md.includes("Related to"));
  });

  it("names the incident it was opened in place of reopening, in the header", () => {
    const incident = example("inc_price_gap");
    incident.relatedTo = { id: "inc_pool_leak", title: "Server errors on GET /products/[id]", why: "Same rule and route, resolved 27 min before this opened." };
    const md = incidentMarkdown(incident, base);
    const header = md.split("\n\n## ")[0];
    assert.match(header, /Related to `inc_pool_leak` \(Server errors on GET \/products\/\[id\]\)\. Same rule and route, resolved 27 min/);
  });

  it("says no issue was found on the control run", () => {
    const md = incidentMarkdown(example("inc_control"), base);
    assert.match(md, /## Verdict\n\nNo issue found\. .+\[ev_/);
  });

  it("says a run without a report is still investigating", () => {
    const incident = { ...example("inc_pool_leak"), status: "investigating" as const, report: undefined };
    const md = incidentMarkdown(incident, base);
    assert.match(md, /Still investigating/);
    assert.doesNotMatch(md, /## Cited evidence/);
  });

  it("never names a commit's author", () => {
    for (const incident of exampleIncidents) {
      const md = incidentMarkdown(incident, base);
      for (const e of incident.evidence) {
        if (e.kind === "commit") assert.ok(!md.includes(e.author), `${incident.id} names ${e.author}`);
      }
    }
  });
});

// The pool leak's record as a dependency incident: the advisory, the
// exposure stage's evidence and the report it builds.
const advisory: NonNullable<Incident["dependency"]> = {
  advisoryId: "GHSA-c2qf-rxjj-qqgw",
  package: "semver",
  title: "semver vulnerable to Regular Expression Denial of Service",
  versions: ["7.5.1"],
  vulnerable: ">=7.0.0 <7.5.2",
  patched: ">=7.5.2",
  severity: "high",
  cwe: ["CWE-1333"],
  url: "https://github.com/advisories/GHSA-c2qf-rxjj-qqgw",
  dev: false,
  direct: ["semver"],
  paths: ["semver"],
  audits: 2,
  lastFoundAt: "2026-11-02T12:00:00.000Z",
};

function dependencyIncident(): Incident {
  const evidence: Evidence[] = [
    { id: "ev_web_1", tool: "dependency_audit", kind: "web", summary: "the advisory", url: advisory.url },
    { id: "ev_source_1", tool: "grep_source", kind: "source", summary: "an import", file: "src/lib/version.ts", startLine: 1, code: 'import semver from "semver";' },
  ];
  const report = exposureReport(
    advisory,
    { verdict: "reachable", rationale: { text: "src/lib/version.ts imports semver and parses request input with it", evidenceIds: ["ev_source_1"] } },
    "The semver package has a known denial-of-service flaw, and the service's version check calls it.",
    "ev_web_1",
    ["shopfront"],
  );
  return { ...example("inc_pool_leak"), dependency: advisory, evidence, steps: [], report, mitigation: undefined };
}

describe("incidentMarkdown on a dependency incident", () => {
  it("shows the advisory and the exposure, with citations", () => {
    const md = incidentMarkdown(dependencyIncident(), base);
    assert.match(md, /## Dependency advisory\n\nGHSA-c2qf-rxjj-qqgw \(high\): semver vulnerable/);
    assert.match(md, /vulnerable `>=7\.0\.0 <7\.5\.2`, patched `>=7\.5\.2`/);
    assert.match(md, /Exposure: reachable: .*imports semver.* \[ev_source_1\]/);
    assert.match(md, /Root cause: \*\*Vulnerable semver@7\.5\.1, reachable from the service's code\*\*/);
    assert.match(md, /- \[ev_web_1\] /);
  });
});

describe("dependencyFindingsMarkdown", () => {
  const finding: StoredFinding = {
    ...advisory,
    service: "shopfront",
    paths: ["next>a>semver", "b>semver", "c>semver", "d>semver"],
    firstSeen: "2026-11-01T12:00:00.000Z",
    lastSeen: "2026-11-02T12:00:00.000Z",
    incidentId: "inc_abc_123456",
  };
  const audit = { service: "shopfront", at: "2026-11-02T12:00:00.000Z", durationMs: 900, packageManager: "pnpm" as const, counts: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 }, runtime: 1 };

  it("tables the findings under the latest audit", () => {
    const md = dependencyFindingsMarkdown("shopfront", [finding], audit);
    assert.match(md, /^Latest audit of `shopfront`: 2026-11-02 12:00:00 UTC with pnpm, 1 runtime advisory\./);
    assert.match(md, /\| GHSA-c2qf-rxjj-qqgw \| `semver` \| 7\.5\.1 \| high \| runtime \|/);
    assert.match(md, /next > a > semver; b > semver; c > semver \(\+1 more\)/);
    assert.match(md, /`inc_abc_123456`/);
  });

  it("says when nothing was found, nothing audited, or the audit failed", () => {
    assert.match(dependencyFindingsMarkdown("shopfront", [], audit), /No vulnerable dependencies found\.$/);
    assert.match(dependencyFindingsMarkdown("shopfront", [], undefined), /haven't been audited yet/);
    assert.match(dependencyFindingsMarkdown("shopfront", [finding], { ...audit, error: "registry offline" }), /failed: registry offline/);
  });
});

describe("incidentListMarkdown", () => {
  it("tables the rows and says when some are left out", () => {
    const rows = exampleIncidents.map((i) => incidentRow(toSummary(i), base, true));
    const md = incidentListMarkdown(rows.slice(0, 2), rows.length);
    assert.match(md, /`inc_pool_leak` \(example\)/);
    assert.match(md, new RegExp(`2 of ${rows.length} shown`));
    assert.equal(incidentListMarkdown([], 0), "No incidents match.");
  });
});

describe("evidenceMarkdown", () => {
  const incident = example("inc_pool_leak");

  it("shows each item with the tool call that found it", () => {
    for (const e of citedEvidence(incident)) {
      const md = evidenceMarkdown(e, incident);
      assert.ok(md.startsWith(`### ${e.id} · ${e.kind}`));
      assert.match(md, /Found by `[a-z_]+` \{/);
    }
  });

  it("caps long series, code and rows", () => {
    const t = (i: number) => new Date(Date.UTC(2026, 9, 23, 2, i)).toISOString();
    const metric: Evidence = {
      id: "ev_metric_9",
      tool: "query_metrics",
      kind: "metric",
      summary: "pool in use",
      metric: "db.pool.in_use",
      unit: "",
      baseline: 2,
      observed: 20,
      series: Array.from({ length: 100 }, (_, i) => ({ t: t(i), value: i })),
    };
    assert.match(evidenceMarkdown(metric, incident), new RegExp(`${SERIES_POINTS} of 100 points`));
    assert.equal(downsample(metric.series, SERIES_POINTS).at(-1)!.value, 99);

    const source: Evidence = {
      id: "ev_source_9",
      tool: "read_source",
      kind: "source",
      summary: "a long file",
      file: "src/a.ts",
      startLine: 10,
      code: Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"),
    };
    const code = evidenceMarkdown(source, incident);
    assert.match(code, new RegExp(`${CODE_LINES} of 200 lines shown`));
    assert.match(code, /\n {2}10 {2}line 0\n/);

    const db: Evidence = {
      id: "ev_db_9",
      tool: "db_diagnostics",
      kind: "db",
      summary: "many rows",
      query: "select 1",
      rows: Array.from({ length: 50 }, (_, i) => ({ n: i })),
    };
    assert.match(evidenceMarkdown(db, incident), new RegExp(`${DB_ROWS} of 50 rows shown`));
  });
});

describe("fixMarkdown", () => {
  it("gives the proven patch, its test and the sandbox runs", () => {
    const incident = example("inc_pool_leak");
    const md = fixMarkdown(incident);
    assert.match(md, /^# Fix for inc_pool_leak/);
    assert.match(md, /```diff\n/);
    assert.ok(md.includes(incident.fix!.regressionTest.name));
    assert.match(md, /## Sandbox proof/);
  });

  it("numbers denied fixes before the current one", () => {
    const incident = example("inc_pool_leak");
    const denied = {
      fix: { ...incident.fix!, summary: "An earlier try" },
      fixRun: incident.fixRun!,
      approval: { state: "denied" as const, requestedAt: incident.detectedAt, reason: "too broad" },
    };
    incident.fixAttempts = [denied];
    assert.match(fixMarkdown(incident), /\(2 of 2\)[\s\S]*Earlier fixes, denied: attempt 1/);
    assert.match(fixMarkdown(incident, 1), /An earlier try\n\nDenied: too broad\. Risk low\./);
    assert.match(fixMarkdown(incident, 3), /pick attempt 1 to 2/);
  });

  it("says why there is no fix", () => {
    assert.match(fixMarkdown(example("inc_control")), /^No fix for `inc_control`/);
  });
});

describe("answerMarkdown", () => {
  it("lists the cited items and flags invented IDs", () => {
    const incident = example("inc_pool_leak");
    const [first] = citedEvidence(incident);
    const question: Question = {
      id: "q_1",
      text: "why?",
      via: "mcp",
      askedAt: incident.detectedAt,
      status: "answered",
      answer: `Because of this [${first.id}] [ev_made_up_1].`,
      citedIds: [first.id],
      unknownIds: ["ev_made_up_1"],
      steps: [],
      evidence: [],
      mode: "tools",
      model: "m",
    };
    const md = answerMarkdown(question, incident, base);
    assert.ok(md.includes(`- [${first.id}] `));
    assert.match(md, /Not real evidence \(ignore these citations\): ev_made_up_1/);
    assert.match(md, /Saved as q_1 on http:\/\/localhost:3000\/incidents\/inc_pool_leak/);
  });
});
