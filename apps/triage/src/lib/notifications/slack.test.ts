import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exampleIncidents } from "../investigation/fixtures";
import type { Incident } from "../investigation/schema";
import { slackMessage } from "./slack";

const base = "http://triage.test";

// The pool-leak example (a report, a fix and a pending approval).
const example = (patch: Partial<Incident> = {}): Incident => ({
  ...structuredClone(exampleIncidents.find((i) => i.fix && i.approval)!),
  ...patch,
});

// The text of the message's one block.
const body = (m: { blocks: unknown[] }) => (m.blocks[0] as { text: { text: string } }).text.text;

describe("slackMessage", () => {
  it("announces a new incident with its severity, service and a link to it", () => {
    const m = slackMessage("incident_opened", example(), base);
    assert.match(m.text, /^New SEV2 incident: /);
    assert.match(body(m), /\*New incident\* · SEV2 · shopfront/);
    assert.ok(body(m).includes(`<${base}/incidents/inc_pool_leak|p95 latency and 500s on GET /api/products/:id>`));
    assert.match(body(m), /p95 latency: 2950 ms observed, limit 500 ms/);
    assert.match(body(m), /Triage is investigating\./);
  });

  it("names the watch rule that tripped when there is one", () => {
    const i = example();
    i.trigger.rule = { id: "api-latency", name: "API latency", description: "p95 over 500 ms on each API route" };
    assert.match(body(slackMessage("incident_opened", i, base)), /p95 over 500 ms on each API route: 2950 ms observed/);
  });

  it("says why a reopened incident came back", () => {
    const i = example({
      reopenings: [{ at: "2026-10-29T10:00:00.000Z", by: "watch", why: "p95 over 500 ms on /api/products again" }],
    });
    const m = slackMessage("incident_reopened", i, base);
    assert.match(m.text, /is back/);
    assert.match(body(m), /p95 over 500 ms on \/api\/products again/);
  });

  it("asks for a review of the fix, with the draft PR when there is one", () => {
    const without = slackMessage("fix_ready", example(), base);
    assert.match(body(without), /\*Fix ready for review\*/);
    assert.ok(body(without).includes(example().fix!.summary));
    assert.ok(body(without).includes(`<${base}/incidents/inc_pool_leak|Review and approve it in Triage>`));
    assert.ok(!body(without).includes("Draft PR"));

    const i = example();
    i.approval = { ...i.approval!, state: "approved", prState: "opened", prUrl: "https://github.com/acme/shop/pull/7" };
    assert.ok(body(slackMessage("fix_ready", i, base)).includes("<https://github.com/acme/shop/pull/7|Draft PR>"));
  });

  it("links the draft PR when it is opened", () => {
    const i = example();
    i.approval = { ...i.approval!, state: "approved", prState: "opened", prUrl: "https://github.com/acme/shop/pull/7" };
    const m = slackMessage("pr_opened", i, base);
    assert.match(m.text, /^Draft PR opened/);
    assert.ok(body(m).includes("<https://github.com/acme/shop/pull/7|Open the draft PR>"));
    assert.ok(body(m).includes(`${base}/incidents/inc_pool_leak|`));
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
    assert.match(body(m), /Open for 1 h 5 min\. Triage confirmed it/);

    const byPerson = slackMessage("resolved", { ...confirmed, verification: undefined }, base);
    assert.match(body(byPerson), /Open for 1 h 5 min\. A person marked it resolved\./);
  });

  it("escapes Slack's markup in text taken from the incident", () => {
    const m = slackMessage("incident_opened", example({ title: "<!channel> a & b > c", service: "<svc>" }), base);
    assert.ok(body(m).includes("|&lt;!channel&gt; a &amp; b &gt; c>"));
    assert.ok(m.text.includes("&lt;!channel&gt; a &amp; b &gt; c"));
    assert.ok(body(m).includes("&lt;svc&gt;"));
    assert.ok(!body(m).includes("<!channel>"));
  });

  it("sends a test that links to Settings, without an incident", () => {
    const m = slackMessage("test", undefined, base);
    assert.match(m.text, /Test from Triage: Slack notifications are working/);
    assert.ok(body(m).includes(`<${base}/settings|Notification settings>`));
  });
});
