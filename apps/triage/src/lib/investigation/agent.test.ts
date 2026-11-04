import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prompt } from "./agent";
import type { Incident } from "./schema";
import type { TelemetrySource } from "./source";

// The alert brief every investigating agent reads (prompt), for an SLO
// alert: inc_mw1ky7ti_11e365 (2026-11-04), the API SLO's 6× alert at
// 03:51:39 on the price list gap, whose 6 h window also held two pool leaks
// with a bigger signal. The investigation blamed the leak.
const now = "2026-11-04T03:51:39.564Z";
const source = {
  describe: () => ({
    id: "live:shopfront",
    now,
    services: [{ name: "shopfront", dependsOn: ["postgres"] }, { name: "postgres", dependsOn: [] }],
    metrics: [],
    flags: { FF_LIST_PRICES: false, FF_STOCK_DIRECT_QUERY: false },
  }),
} as unknown as TelemetrySource;

const incident = (burn: Incident["trigger"]["burn"]): Incident => ({
  id: "inc_test",
  title: "Error budget burning 118× on GET /api/products/[id]",
  service: "shopfront",
  severity: "sev2",
  status: "investigating",
  detectedAt: now,
  openedBy: "watch",
  trigger: {
    metric: "slo.burn_rate{route=/api/products/[id],objective=99.9,le=500}",
    unit: "×",
    threshold: 6,
    observed: 90.91,
    series: [],
    rule: { id: "api-slo", name: "API SLO", description: "99.9% of requests succeed within 500 ms over 30 days on each API route" },
    route: "/api/products/[id]",
    burn,
  },
  steps: [],
  evidence: [],
});

const sixX = { rate: 118.2, threshold: 6, longMs: 6 * 3_600_000, shortMs: 30 * 60_000, budgetLeftPercent: -11723 };

describe("the alert brief for an SLO alert", () => {
  it("states the minutes the alert is burning on, and that earlier outages aren't this incident", () => {
    const brief = prompt(incident({ ...sixX, burning: { from: "2026-11-04T03:32:00.000Z", to: "2026-11-04T03:49:00.000Z" } }), source);
    assert.match(brief, /Error budget: burning 118× over the last 6 h \(the alert fires over 6× in both the last 6 h and 30 min\)/);
    assert.match(
      brief,
      /The bad minutes the alert is burning on: 03:32 to 03:49 UTC, from when this burn began\. Earlier outages in the alert's 6 h window are not this incident; diagnose what failed in those minutes\./,
    );
    // 20 min before the alert: the tools' 30 min default reaches them.
    assert.doesNotMatch(brief, /widen windowMinutes/);
  });

  it("says to widen the tools' window when the minutes began more than 30 min before the alert", () => {
    const brief = prompt(incident({ ...sixX, burning: { from: "2026-11-04T03:05:00.000Z", to: "2026-11-04T03:49:00.000Z" } }), source);
    assert.match(brief, /They began 47 min before the alert: widen windowMinutes to reach them\./);
  });

  it("points at the short window when the minutes aren't known", () => {
    const brief = prompt(incident(sixX), source);
    assert.match(brief, /The alert fires only while the last 30 min are burning too\. Earlier outages in the alert's 6 h window are not this incident; diagnose what failed in the last 30 min\./);
    assert.doesNotMatch(brief, /bad minutes/);
  });

  it("says nothing of a burn on another alert", () => {
    const brief = prompt(incident(undefined), source);
    assert.doesNotMatch(brief, /Error budget:|burning on|Earlier outages/);
  });
});
