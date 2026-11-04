import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exampleIncidents } from "../investigation/fixtures";
import type { Incident } from "../investigation/schema";
import { incidentCard, type SlackMessage, slackMessage } from "./slack";

const base = "http://triage.test";

// The pool-leak example (a report, a fix and a pending approval).
const example = (patch: Partial<Incident> = {}): Incident => ({
  ...structuredClone(exampleIncidents.find((i) => i.fix && i.approval)!),
  ...patch,
});

type Block = { type: string; text?: { text: string }; elements?: { text: string }[] };
const textOf = (b: unknown) => {
  const block = b as Block;
  return block.text?.text ?? block.elements!.map((e) => e.text).join(" ");
};

// The status line above the card.
const status = (m: SlackMessage) => textOf(m.blocks[0]);
// The card's lines, the small-type details last.
const card = (m: SlackMessage) => m.attachments[0].blocks.map(textOf).join("\n");
const details = (m: SlackMessage) => textOf(m.attachments[0].blocks.at(-1));
const color = (m: SlackMessage) => m.attachments[0].color;

// The example as an incident the dependency audit opened, still running.
const dependencyIncident = (patch: Partial<Incident> = {}): Incident =>
  example({
    title: "Vulnerable dependency: semver@7.5.1 (high, GHSA-c2qf-rxjj-qqgw)",
    severity: "sev3",
    status: "investigating",
    mitigation: undefined,
    approval: undefined,
    fix: undefined,
    report: undefined,
    dependency: {
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
    },
    ...patch,
  });

describe("slackMessage", () => {
  it("announces a new incident with its severity, service, the numbers and a link to it", () => {
    const m = slackMessage("incident_opened", example(), base);
    assert.match(m.text, /^New SEV2 incident: /);
    assert.equal(status(m), "*New incident*");
    assert.ok(card(m).includes(`*<${base}/incidents/inc_pool_leak|p95 latency and 500s on GET /api/products/:id>*`));
    assert.equal(details(m), "SEV2 · shopfront · 2950 ms observed · limit 500 ms · Triage is investigating");
  });

  it("colors the card by what the message is about", () => {
    assert.equal(color(slackMessage("incident_opened", example(), base)), "#E01E5A");
    assert.equal(color(slackMessage("incident_opened", example({ severity: "sev3" }), base)), "#ECB22E");
    assert.equal(color(slackMessage("fix_ready", example(), base)), "#7D3DF3");
    assert.equal(color(slackMessage("resolved", example({ resolvedAt: "2026-10-23T03:19:00.000Z" }), base)), "#2EB67D");
  });

  it("leaves the rule to the title and rounds what was observed", () => {
    const i = example();
    i.trigger.rule = { id: "api-latency", name: "API latency", description: "p95 over 500 ms on each API route" };
    i.trigger.observed = 1543.3;
    const m = slackMessage("incident_opened", i, base);
    assert.ok(!card(m).includes("each API route"));
    assert.match(details(m), /1543 ms observed · limit 500 ms/);
  });

  it("says why a reopened incident came back", () => {
    const i = example({
      reopenings: [{ at: "2026-10-29T10:00:00.000Z", by: "watch", why: "p95 over 500 ms on /api/products again" }],
    });
    const m = slackMessage("incident_reopened", i, base);
    assert.match(m.text, /is back/);
    assert.equal(status(m), "*Incident is back*");
    assert.match(card(m), /p95 over 500 ms on \/api\/products again/);
    assert.match(details(m), /Resolved earlier, so Triage reopened it/);
  });

  it("asks for a review of the fix, with what happened, the fix quoted and the draft PR when there is one", () => {
    const without = slackMessage("fix_ready", example(), base);
    assert.equal(status(without), "*Fix ready for review*");
    assert.ok(card(without).includes(`*What happened:* ${example().report!.summary}`));
    assert.ok(card(without).includes(`>${example().fix!.summary}`));
    assert.match(details(without), /^SEV2 · shopfront · \d+ files? · \w+ risk · Proven in a sandbox · /);
    assert.ok(details(without).includes(`<${base}/incidents/inc_pool_leak|Review and approve it in Triage>`));
    assert.ok(!card(without).includes("Draft PR"));

    const i = example();
    i.approval = { ...i.approval!, state: "approved", prState: "opened", prUrl: "https://github.com/acme/shop/pull/7" };
    assert.ok(details(slackMessage("fix_ready", i, base)).includes("<https://github.com/acme/shop/pull/7|Draft PR>"));
  });

  it("says when the fix changes stored data", () => {
    assert.ok(!card(slackMessage("fix_ready", example(), base)).includes("stored data"));
    const gap = structuredClone(exampleIncidents.find((i) => i.id === "inc_price_gap")!);
    const m = slackMessage("fix_ready", gap, base);
    assert.match(m.text, /^Fix ready for review \(changes stored data\)/);
    assert.equal(status(m), "*Fix ready for review* · changes stored data");
    assert.ok(card(m).includes("*changes stored data*"));
    assert.ok(!details(m).includes("Proven in a sandbox"));
    assert.ok(details(m).includes("|Review the data change and approve it in Triage>"));
  });

  it("links the draft PR when it is opened", () => {
    const i = example();
    i.approval = { ...i.approval!, state: "approved", prState: "opened", prUrl: "https://github.com/acme/shop/pull/7" };
    const m = slackMessage("pr_opened", i, base);
    assert.match(m.text, /^Draft PR opened/);
    assert.ok(card(m).includes("<https://github.com/acme/shop/pull/7|Open the draft PR>"));
    assert.ok(card(m).includes(`${base}/incidents/inc_pool_leak|`));
  });

  it("says how long a resolved incident was open and who confirmed it", () => {
    const resolvedAt = "2026-10-23T03:19:00.000Z";
    const confirmed = example({
      status: "resolved",
      resolvedAt,
      verification: {
        after: "fix",
        since: "2026-10-23T03:10:00.000Z",
        windowMinutes: 5,
        metric: "http.server.duration p95",
        threshold: 500,
        series: [],
        status: "resolved",
        startedAt: "2026-10-23T03:10:00.000Z",
      },
    });
    const m = slackMessage("resolved", confirmed, base);
    assert.match(m.text, /^Resolved: /);
    assert.equal(status(m), "*Resolved after 1 h 5 min*");
    assert.match(card(m), /Triage confirmed it/);

    const byPerson = slackMessage("resolved", { ...confirmed, verification: undefined }, base);
    assert.match(card(byPerson), /A person marked it resolved\./);
  });

  it("counts the healthy checks that confirmed an uptime incident's recovery", () => {
    const point = (t: string) => ({ t, value: 184 });
    const i = example({
      status: "resolved",
      resolvedAt: "2026-10-23T03:19:00.000Z",
      verification: {
        after: "uptime",
        since: "2026-10-23T03:18:00.000Z",
        windowMinutes: 1,
        metric: "uptime.response_time{check=chk_abc123}",
        threshold: 10_000,
        series: [point("2026-10-23T03:18:00.000Z"), point("2026-10-23T03:18:30.000Z"), point("2026-10-23T03:19:00.000Z")],
        status: "resolved",
        startedAt: "2026-10-23T03:18:00.000Z",
      },
    });
    assert.match(card(slackMessage("resolved", i, base)), /Triage confirmed it: 3 checks in a row answered in time\./);
  });

  it("says the audit confirmed a dependency incident, not a metric", () => {
    const at = "2026-10-23T03:19:00.000Z";
    const verification: Incident["verification"] = {
      after: "dependencies",
      since: at,
      windowMinutes: 1,
      metric: "vulnerable_dependencies{advisory=GHSA-c2qf-rxjj-qqgw}",
      threshold: 1,
      series: [{ t: at, value: 0 }],
      status: "resolved",
      startedAt: at,
    };
    const dependency = { advisoryId: "GHSA-c2qf-rxjj-qqgw" } as Incident["dependency"];
    const merged = example({ status: "resolved", resolvedAt: at, dependency, verification });
    const text = card(slackMessage("resolved", merged, base));
    assert.match(text, /the next audit no longer finds GHSA-c2qf-rxjj-qqgw\./);
    assert.doesNotMatch(text, /quiet window/);

    const note = "The audit no longer finds GHSA-c2qf-rxjj-qqgw: the dependency changed without a Triage PR.";
    const elsewhere = example({ status: "resolved", resolvedAt: at, dependency, verification: { ...verification!, note } });
    assert.match(card(slackMessage("resolved", elsewhere, base)), /changed without a Triage PR/);
  });

  it("escapes Slack's markup in text taken from the incident", () => {
    const m = slackMessage("incident_opened", example({ title: "<!channel> a & b > c", service: "<svc>" }), base);
    assert.ok(card(m).includes("|&lt;!channel&gt; a &amp; b &gt; c>"));
    assert.ok(m.text.includes("&lt;!channel&gt; a &amp; b &gt; c"));
    assert.ok(card(m).includes("&lt;svc&gt;"));
    assert.ok(!card(m).includes("<!channel>"));
  });

  it("sends a test that links to Settings, without an incident", () => {
    const m = slackMessage("test", undefined, base);
    assert.match(m.text, /Test from Triage: Slack notifications are working/);
    assert.ok(card(m).includes(`<${base}/settings|Notification settings>`));
  });
});

describe("incidentCard", () => {
  const actionIds = (m: SlackMessage) =>
    (m.attachments[0].blocks.find((b) => (b as Block).type === "actions") as { elements: { action_id: string }[] } | undefined)?.elements.map(
      (e) => e.action_id,
    ) ?? [];

  it("says where the incident stands, with what happened and the mitigation", () => {
    const m = incidentCard(example(), base);
    assert.equal(status(m), "*Mitigation waiting for approval*");
    assert.equal(color(m), "#7D3DF3");
    assert.match(card(m), /\*What happened:\* /);
    assert.match(card(m), /\*Mitigation:\* .* · waiting for approval/);
    assert.match(card(m), /\*Fix:\* .* · waiting for review/);
  });

  it("has buttons only when interactive, and approve buttons for what waits", () => {
    assert.deepEqual(actionIds(incidentCard(example(), base)), []);
    assert.deepEqual(actionIds(incidentCard(example(), base, { interactive: true })), [
      "mitigation_approve",
      "mitigation_deny",
      "fix_approve",
      "open_triage",
    ]);
  });

  it("offers no button to approve a fix that changes stored data", () => {
    const gap = structuredClone(exampleIncidents.find((i) => i.id === "inc_price_gap")!);
    gap.mitigation = undefined;
    assert.deepEqual(actionIds(incidentCard(gap, base, { interactive: true })), ["open_triage"]);
  });

  it("names who decided in Slack, and drops the buttons once decided", () => {
    const i = example();
    i.mitigation = { ...i.mitigation!, state: "denied", decidedBy: "ana", decidedInSlack: "U0APPROVER" };
    i.approval = { ...i.approval!, state: "approved", prState: "opened", prUrl: "https://github.com/acme/shop/pull/7", decidedBy: "Dana" };
    const m = incidentCard(i, base, { interactive: true });
    assert.equal(status(m), "*Draft PR opened*");
    assert.match(card(m), /denied by <@U0APPROVER>/);
    assert.match(card(m), /approved by Dana · <https:\/\/github.com\/acme\/shop\/pull\/7\|draft PR>/);
    assert.deepEqual(actionIds(m), []);
  });

  it("names a dependency incident's package and severity, then its exposure, in the status line", () => {
    const i = dependencyIncident();
    const opened = incidentCard(i, base);
    assert.equal(status(opened), "*Dependency advisory: semver@7.5.1 (high)*");
    assert.equal(details(opened), "SEV3 · shopfront · GHSA-c2qf-rxjj-qqgw · found by 2 audits");
    assert.equal(status(slackMessage("incident_opened", i, base)), "*Dependency advisory: semver@7.5.1 (high)*");

    const diagnosed = dependencyIncident({ status: "diagnosed" });
    diagnosed.report = {
      ...example().report!,
      exposure: { verdict: "reachable", rationale: { text: "src/lib/version.ts imports semver", evidenceIds: ["ev_source_1"] } },
    };
    assert.equal(status(incidentCard(diagnosed, base)), "*Dependency advisory: semver@7.5.1 (high) · reachable from the code*");
    // Later states say what waits, as on any incident.
    diagnosed.fix = example().fix;
    diagnosed.approval = example().approval;
    assert.equal(status(incidentCard(diagnosed, base)), "*Fix ready for review*");
  });

  it("turns green once resolved, dropping the mitigation's buttons but not the fix's", () => {
    const m = incidentCard(example({ status: "resolved", resolvedAt: "2026-10-23T03:19:00.000Z" }), base, { interactive: true });
    assert.equal(status(m), "*Resolved after 1 h 5 min*");
    assert.equal(color(m), "#2EB67D");
    assert.deepEqual(actionIds(m), ["fix_approve", "open_triage"]);
  });
});
