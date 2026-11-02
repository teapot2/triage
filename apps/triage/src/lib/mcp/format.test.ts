import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { citationOrder } from "../investigation/citations";
import { exampleIncidents } from "../investigation/fixtures";
import type { Evidence, Incident, Question } from "../investigation/schema";
import {
  answerMarkdown,
  CODE_LINES,
  citedEvidence,
  DB_ROWS,
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

describe("incidentListMarkdown", () => {
  it("tables the rows and says when some are left out", () => {
    const rows = exampleIncidents.map((i) => incidentRow(i, base, true));
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
