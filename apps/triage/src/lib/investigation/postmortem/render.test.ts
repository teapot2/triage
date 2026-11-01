import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { citationOrder } from "../citations";
import type { Evidence, Incident } from "../schema";
import { exampleIncidents } from "../fixtures";
import { footnoteNumbers, postmortemMarkdown, postmortemParts, statusInWords } from "./render";
import { type BuiltInSection, builtInSections, type Template } from "./template";
import { mitigated, poolLeak, reopened, resolved } from "./test-incidents";

const headings: Record<BuiltInSection | "header" | "evidence", string> = {
  header: "# Postmortem: ",
  summary: "## Summary",
  impact: "## Impact",
  timeline: "## Timeline",
  outcome: "## How the diagnosis held up",
  factors: "## Contributing factors",
  lessons: "## Lessons",
  lucky: "## Where we got lucky",
  actions: "## Action items",
  evidence: "## Evidence",
};

// Lucky dropped, Action items above Lessons, and a section of the team's own.
const teamTemplate: Template = {
  sections: [
    { kind: "builtin", key: "summary" },
    { kind: "builtin", key: "impact" },
    { kind: "builtin", key: "timeline" },
    { kind: "builtin", key: "factors" },
    { kind: "builtin", key: "actions" },
    {
      kind: "custom",
      id: "customer-communication",
      name: "Customer communication",
      instructions: "Who was told what and when, from the record; say if nothing was recorded",
    },
    { kind: "builtin", key: "lessons" },
  ],
};

function withTemplate(template: Template, custom = true): Incident {
  const incident = poolLeak();
  incident.postmortem = {
    ...incident.postmortem!,
    template,
    custom: custom
      ? [
          {
            id: "customer-communication",
            name: "Customer communication",
            text: "The status page was updated at 02:12 UTC; no customer message is recorded.",
            evidenceIds: ["ev_log_timeout", "ev_metric_p95"],
          },
        ]
      : undefined,
  };
  return incident;
}

const headingsOf = (md: string) => [...md.matchAll(/^#{1,2} .*$/gm)].map((m) => m[0]);

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
  it("renders the default sections in order, between the header and the appendix", () => {
    const md = postmortemMarkdown(poolLeak());
    const keys = ["header", ...builtInSections, "evidence"] as const;
    const positions = keys.map((key) => md.indexOf(headings[key]));
    assert.ok(positions.every((p) => p >= 0), `missing a section: ${positions}`);
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
    assert.ok(md.trimEnd().endsWith("A draft until the team has read it."));
  });

  it("renders an old record, without a template, as the default", () => {
    const old = poolLeak();
    assert.equal(old.postmortem!.template, undefined);
    const saved = withTemplate({ sections: builtInSections.map((key) => ({ kind: "builtin" as const, key })) }, false);
    assert.equal(postmortemMarkdown(old), postmortemMarkdown(saved));
  });

  it("follows the record's template: dropped, moved and custom sections", () => {
    const md = postmortemMarkdown(withTemplate(teamTemplate));
    assert.deepEqual(
      headingsOf(md).map((h) => h.replace(/^# Postmortem: .*/, "# Postmortem")),
      [
        "# Postmortem",
        "## Summary",
        "## Impact",
        "## Timeline",
        "## Contributing factors",
        "## Action items",
        "## Customer communication",
        "## Lessons",
        "## Evidence",
      ],
    );
    assert.ok(!md.includes("## Where we got lucky"));
  });

  it("renders a custom section's text with footnote markers, listed in the appendix", () => {
    const incident = withTemplate(teamTemplate);
    const md = postmortemMarkdown(incident);
    const numbers = footnoteNumbers(incident);
    const markers = ["ev_log_timeout", "ev_metric_p95"]
      .map((id) => numbers.get(id)!)
      .sort((a, b) => a - b)
      .map((n) => `[${n}]`)
      .join("");
    assert.ok(section(md, "## Customer communication").includes(`no customer message is recorded. ${markers}`));
    for (const id of ["ev_log_timeout", "ev_metric_p95"]) {
      assert.ok(section(md, "## Evidence").includes(`- [${numbers.get(id)}] `));
    }
  });

  it("says a custom section is not written yet when the record has no text for it", () => {
    const md = postmortemMarkdown(withTemplate(teamTemplate, false));
    assert.equal(section(md, "## Customer communication").trim(), "## Customer communication\n\n_Not written yet._");
  });

  it("has no Contributing factors heading when the template dropped Factors", () => {
    const template: Template = { sections: teamTemplate.sections.filter((s) => !(s.kind === "builtin" && s.key === "factors")) };
    const md = postmortemMarkdown(withTemplate(template));
    assert.ok(!md.includes("## Contributing factors"));
    assert.ok(md.includes("## Summary"));
  });

  it("keeps the header and appendix when the template keeps one section", () => {
    const md = postmortemMarkdown(withTemplate({ sections: [{ kind: "builtin", key: "actions" }] }, false));
    assert.deepEqual(headingsOf(md).map((h) => h.slice(0, 11)), ["# Postmorte", "## Action i", "## Evidence"]);
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

  it("says when it resolved, and ends the timeline there with the time to resolve", () => {
    const md = postmortemMarkdown(resolved());
    assert.ok(md.split("\n## ")[0].includes("shopfront · SEV2 · resolved 2026-10-23 02:23:00 UTC · Detected"));
    const timeline = section(md, "## Timeline");
    assert.ok(timeline.includes("| 02:18:05 | Verification started: watching p95 latency for 5 min |"));
    assert.match(timeline, /\| 02:23:00 \| Incident resolved \|\n\n/);
    assert.ok(timeline.includes("Time to resolve: 13 min"));
  });

  it("puts a reopening in the timeline and no resolution in the header", () => {
    const md = postmortemMarkdown(reopened());
    assert.ok(md.split("\n## ")[0].includes("shopfront · SEV2 · fix awaiting approval"));
    const timeline = section(md, "## Timeline");
    assert.ok(timeline.includes("| 02:30:00 | Reopened by Triage's watch: p95 latency back over 500 ms |"));
    assert.ok(!timeline.includes("Incident resolved"));
    assert.ok(!timeline.includes("Time to resolve"));
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

describe("How the diagnosis held up", () => {
  const outcome = (incident: Incident) => section(postmortemMarkdown(incident), "## How the diagnosis held up");

  it("states the diagnosis, its grade and the outcome, each signal with its time, then the review", () => {
    const incident = poolLeak();
    const text = outcome(incident);
    assert.ok(
      text.includes(
        "Diagnosed: Connection leak in getStockLevel exhausts the pg pool, confidence 0.86 (Validated, alternatives ruled out). Outcome: Confirmed.",
      ),
    );
    assert.ok(text.includes('- 2026-10-23 02:16:28 The regression test "releases the client when the stock row is missing" failed on the original code and passes with the fix'));
    const numbers = footnoteNumbers(incident);
    const markers = ["ev_db_activity", "ev_source_stock"]
      .map((id) => numbers.get(id)!)
      .sort((a, b) => a - b)
      .map((n) => `[${n}]`)
      .join("");
    assert.ok(text.trimEnd().endsWith(`the idle, checked-out connections. ${markers}`));
  });

  it("lists every signal of a reopened incident and says it held with caveats", () => {
    const text = outcome(reopened());
    assert.ok(text.includes("Outcome: Held with caveats."));
    assert.ok(text.includes("- 2026-10-23 02:18:00 Turning off FF_STOCK_DIRECT_QUERY brought p95 latency back under 500 ms"));
    assert.ok(text.includes("- 2026-10-23 02:30:00 Reopened by Triage's watch: p95 latency back over 500 ms"));
  });

  it("renders for a postmortem from before the section, with the review not written yet", () => {
    const incident = poolLeak();
    incident.postmortem!.verdictReview = undefined;
    const text = outcome(incident);
    assert.ok(text.includes("Outcome: Confirmed."));
    assert.ok(text.trimEnd().endsWith("_Not written yet._"));
    // While it is written, what isn't yet is left out.
    const drafting = postmortemParts(incident, { drafting: true }).sections.find((s) => s.key === "outcome")!.markdown;
    assert.ok(!drafting.includes("Not written yet"));
    assert.ok(drafting.includes("Outcome: Confirmed."));
  });

  it("has no diagnosis to check on a healthy run", () => {
    const control = structuredClone(exampleIncidents.find((i) => i.id === "inc_control")!);
    assert.equal(outcome(control).trim(), "## How the diagnosis held up\n\n_No diagnosis to check._");
  });
});

describe("postmortemMarkdown for an uptime check", () => {
  it("gives availability's lowest point and the time under the limit", () => {
    const incident = poolLeak();
    incident.trigger = {
      ...incident.trigger,
      metric: "uptime.availability{check=chk_abc123}",
      unit: "%",
      threshold: 100,
      observed: 0,
      series: [100, 100, 50, 0, 0, 0].map((value, i) => ({ t: new Date(Date.parse("2026-10-23T02:00:00.000Z") + i * 60_000).toISOString(), value })),
    };
    incident.detectedAt = "2026-10-23T02:05:00.000Z";
    incident.mitigation = undefined;
    const md = postmortemMarkdown(incident);
    assert.match(md, /- Lowest Availability: 0%, against a threshold of 100%\./);
    assert.match(md, /- Under the threshold for at least 4 min, from 02:02:00 UTC\./);
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
