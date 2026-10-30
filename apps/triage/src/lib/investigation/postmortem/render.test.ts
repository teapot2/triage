import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { citationOrder } from "../citations";
import type { Evidence, Incident } from "../schema";
import { defaultTemplate, footnoteNumbers, postmortemMarkdown, statusInWords } from "./render";
import { mitigated, poolLeak } from "./test-incidents";

const headings: Record<(typeof defaultTemplate)[number], string> = {
  header: "# Postmortem: ",
  summary: "## Summary",
  impact: "## Impact",
  timeline: "## Timeline",
  factors: "## Contributing factors",
  lessons: "## Lessons",
  lucky: "## Where we got lucky",
  actions: "## Action items",
  evidence: "## Evidence",
};

const section = (md: string, heading: string) => md.slice(md.indexOf(heading)).split(/\n## /)[0];

const questionEvidence: Evidence = {
  id: "ev_q1_log_1",
  kind: "log",
  tool: "query_logs",
  summary: "pool timeouts stopped at 02:15",
  service: "shopfront",
  level: "info",
  message: "ok",
};

function withQuestion(incident: Incident): Incident {
  return {
    ...incident,
    questions: [
      {
        id: "q_1",
        text: "Did the timeouts stop?",
        askedAt: "2026-10-23T02:19:00.000Z",
        answeredAt: "2026-10-23T02:19:10.000Z",
        status: "answered",
        answer: "Yes [ev_q1_log_1].",
        citedIds: ["ev_q1_log_1"],
        unknownIds: [],
        steps: [],
        evidence: [questionEvidence],
        mode: "evidence_only",
        model: "muse-spark-1.3",
      },
    ],
  };
}

describe("postmortemMarkdown", () => {
  it("renders the sections in defaultTemplate order", () => {
    const md = postmortemMarkdown(poolLeak());
    const positions = defaultTemplate.map((key) => md.indexOf(headings[key]));
    assert.ok(positions.every((p) => p >= 0), `missing a section: ${positions}`);
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
    assert.ok(md.trimEnd().endsWith("A draft until the team has read it."));
  });

  it("follows a custom template", () => {
    const md = postmortemMarkdown(poolLeak(), ["header", "actions", "summary"]);
    assert.ok(md.indexOf("## Action items") < md.indexOf("## Summary"));
    assert.ok(!md.includes("## Timeline"));
    assert.ok(!md.includes("## Evidence"));
  });

  it("has the status in words in the header, and not the commit author", () => {
    const header = postmortemMarkdown(poolLeak()).split("\n## ")[0];
    assert.match(header, /^# Postmortem: p95 latency and 500s on GET \/api\/products\/:id/);
    assert.ok(header.includes("shopfront · SEV2 · fix awaiting approval"));
    assert.ok(header.includes("Detected 2026-10-23 02:14:00 UTC by Triage's watch"));
    assert.ok(header.includes("Written by Triage (muse-spark-1.3) on 2026-10-23 02:20:41 UTC"));
    assert.ok(!header.includes("sebastian"));
  });

  it("puts the mitigation in the timeline and the durations under it", () => {
    const timeline = section(postmortemMarkdown(mitigated()), "## Timeline");
    assert.ok(timeline.includes("All times on 2026-10-23, UTC."));
    assert.ok(timeline.includes("| 02:15:20 | Mitigation applied |"));
    assert.ok(timeline.includes("| 02:18:00 | p95 latency back under 500 ms |"));
    assert.ok(timeline.includes("Time to detect: 4 min"));
    assert.ok(timeline.includes("Time to recover: 8 min"));
  });

  it("says how long the metric was over the threshold, at least when it hasn't recovered", () => {
    assert.ok(section(postmortemMarkdown(poolLeak()), "## Impact").includes("for at least 10 min, from 02:10:00 UTC"));
    assert.ok(section(postmortemMarkdown(mitigated()), "## Impact").includes("for 8 min, from 02:10:00 UTC"));
  });

  it("makes the fix action item 1, with the PR link once it is open", () => {
    const pending = section(postmortemMarkdown(poolLeak()), "## Action items");
    assert.match(pending, /\| 1 \| Review the proposed fix: Release the pooled client/);
    const incident = poolLeak();
    incident.approval = {
      state: "approved",
      requestedAt: "2026-10-23T02:16:30.000Z",
      decidedAt: "2026-10-23T02:17:00.000Z",
      decidedBy: "Dana Reviewer",
      prState: "opened",
      prUrl: "https://github.com/acme/shopfront/pull/7",
    };
    const md = postmortemMarkdown(incident);
    const actions = section(md, "## Action items");
    assert.match(actions, /\| 1 \| Merge the fix: Release the pooled client.*\(\[PR\]\(https:\/\/github\.com\/acme\/shopfront\/pull\/7\)\) \| Fix this \| P1 \|/);
    assert.match(actions, /\| 2 \| Lint for pooled clients .* \| Prevent the class \| P2 \|  \|  \|/);
    assert.ok(md.includes("fix approved, PR open"));
  });

  it("strikes an unknown evidence ID", () => {
    const incident = poolLeak();
    incident.postmortem!.wentBadly = [{ text: "A claim on missing evidence.", evidenceIds: ["ev_source_stock", "ev_log_ghost"] }];
    const lessons = section(postmortemMarkdown(incident), "## Lessons");
    const n = footnoteNumbers(incident).get("ev_source_stock");
    assert.ok(lessons.includes(`- A claim on missing evidence. [${n}] ~~ev_log_ghost~~`));
  });

  it("never names a commit author or an approver", () => {
    const incident = mitigated();
    incident.approval = { ...incident.approval!, state: "denied", decidedAt: "2026-10-23T02:17:00.000Z", decidedBy: "Dana Reviewer", reason: "smaller change" };
    for (const md of [postmortemMarkdown(poolLeak()), postmortemMarkdown(incident)]) {
      assert.ok(!/sebastian/i.test(md));
      assert.ok(!md.includes("Dana"));
    }
  });

  it("lists every cited footnote in the Evidence appendix, in order", () => {
    const md = postmortemMarkdown(mitigated());
    const appendix = section(md, "## Evidence");
    const listed = [...appendix.matchAll(/^- \[(\d+)\] /gm)].map((m) => Number(m[1]));
    const body = md.slice(0, md.indexOf("## Evidence"));
    const cited = [...new Set([...body.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
    assert.deepEqual(listed, cited);
    assert.ok(appendix.includes("Deploy · a1b9c4e · feat: show stock level on product page"));
    assert.ok(appendix.includes("Config change · FF_STOCK_DIRECT_QUERY"));
  });

  it("renders without a postmortem record", () => {
    const md = postmortemMarkdown({ ...poolLeak(), postmortem: undefined });
    assert.ok(md.includes("## Summary\n\nNot written yet."));
    assert.ok(!md.includes("Written by Triage ("));
  });
});

describe("footnoteNumbers", () => {
  it("numbers like EvidenceProvider: the report's citations, then the evidence, then the questions'", () => {
    const incident = withQuestion(poolLeak());
    incident.report!.hypotheses[1].rejectedBecause!.evidenceIds.push("ev_not_there");
    const evidence = [...incident.evidence, ...incident.questions!.flatMap((q) => q.evidence)];
    // EvidenceProvider's rule, restated.
    const byId = new Set(evidence.map((e) => e.id));
    const order = citationOrder(incident.report!).filter((id) => byId.has(id));
    const expected = [...new Set([...order, ...evidence.map((e) => e.id)])];
    const numbers = footnoteNumbers(incident);
    assert.deepEqual([...numbers.keys()], expected);
    assert.deepEqual([...numbers.values()], expected.map((_, i) => i + 1));
    assert.equal(numbers.get("ev_metric_p95"), 1);
    assert.equal(numbers.get("ev_q1_log_1"), evidence.length);
    assert.equal(numbers.has("ev_not_there"), false);
  });
});

describe("statusInWords", () => {
  it("picks the most specific status that holds", () => {
    const open: Incident = { ...poolLeak(), status: "diagnosed", approval: undefined };
    assert.equal(statusInWords(open), "open");
    assert.equal(statusInWords(mitigated()), "fix awaiting approval");
    assert.equal(statusInWords({ ...mitigated(), approval: undefined, status: "diagnosed" }), "mitigated");
    assert.equal(statusInWords({ ...poolLeak(), status: "resolved" }), "resolved");
    assert.equal(statusInWords({ ...poolLeak(), status: "healthy" }), "no issue found");
    assert.equal(statusInWords({ ...poolLeak(), status: "failed" }), "investigation failed");
  });
});
