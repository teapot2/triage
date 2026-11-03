import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exampleIncidents } from "./fixtures";
import { incidentToReopen, REOPEN_WINDOW_MINUTES } from "./reopen";
import type { Incident } from "./schema";

const now = Date.parse("2026-10-29T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();
const trip = { ruleId: "api-latency", route: "/api/products" };

// An incident the watch opened on a rule and route, `opened` minutes ago.
function incident(
  id: string,
  opened: number,
  { ruleId = trip.ruleId, route = trip.route, ...rest }: Partial<Incident> & { ruleId?: string; route?: string } = {},
): Incident {
  const example = structuredClone(exampleIncidents[0]);
  return {
    ...example,
    id,
    title: `p95 latency above 500 ms on GET ${route}`,
    detectedAt: minutesAgo(opened),
    openedBy: "watch",
    trigger: { ...example.trigger, rule: { id: ruleId, name: "API latency", description: "p95 over 500 ms" }, route },
    status: "diagnosed",
    ...rest,
  };
}

describe("incidentToReopen", () => {
  const inside = incident("inc_inside", 50, { status: "resolved", resolvedAt: minutesAgo(10) });
  const outside = incident("inc_outside", 120, { status: "resolved", resolvedAt: minutesAgo(REOPEN_WINDOW_MINUTES + 5) });
  const otherRule = incident("inc_other_rule", 40, { ruleId: "api-errors", status: "resolved", resolvedAt: minutesAgo(5) });

  it("reopens the resolved incident inside the window", () => {
    assert.equal(incidentToReopen([inside, outside, otherRule], trip, now)?.id, "inc_inside");
  });

  it("leaves one resolved outside the window", () => {
    assert.equal(incidentToReopen([outside], trip, now), undefined);
  });

  it("leaves one on another rule", () => {
    assert.equal(incidentToReopen([otherRule], trip, now), undefined);
  });

  it("leaves one with a newer open incident on the same rule after it", () => {
    const newer = incident("inc_newer_open", 5, { route: "/api/products/[id]", status: "investigating" });
    assert.equal(incidentToReopen([newer, inside], trip, now), undefined);
  });

  it("counts a breached verification as the end when it was never resolved", () => {
    const breached = incident("inc_breached", 30, {
      verification: {
        after: "mitigation",
        since: minutesAgo(25),
        windowMinutes: 10,
        metric: "http.server.request.duration.p95{route=/api/products}",
        threshold: 500,
        series: [],
        status: "breached",
        startedAt: minutesAgo(25),
        breachedAt: minutesAgo(20),
      },
    });
    assert.equal(incidentToReopen([breached], trip, now)?.id, "inc_breached");
  });

  it("joins an incident still verifying on the same rule and route, not on another route", () => {
    const verifying = incident("inc_verifying", 15, {
      status: "awaiting_approval",
      verification: {
        after: "mitigation",
        since: minutesAgo(4),
        windowMinutes: 5,
        metric: "http.server.request.duration.p95{route=/api/products}",
        threshold: 500,
        series: [],
        status: "verifying",
        startedAt: minutesAgo(3),
      },
    });
    assert.equal(incidentToReopen([verifying], trip, now)?.id, "inc_verifying");
    assert.equal(incidentToReopen([verifying], { ...trip, route: "/api/products/[id]" }, now), undefined);
  });

  it("joins an incident whose mitigation's recovery is still being watched", () => {
    const base = incident("inc_watching", 10);
    const watching = incident("inc_watching", 10, {
      mitigation: {
        ...base.mitigation!,
        state: "applied",
        appliedAt: minutesAgo(2),
        recovery: { metric: base.trigger.metric, threshold: 500, since: minutesAgo(2), series: [], status: "watching" },
      },
    });
    assert.equal(incidentToReopen([watching], trip, now)?.id, "inc_watching");
  });

  it("leaves an archived one, even inside the window", () => {
    const archived = { ...inside, archivedAt: minutesAgo(5) };
    assert.equal(incidentToReopen([archived], trip, now), undefined);
    // Skipping it, the match before it is the one reopened.
    const older = incident("inc_older_inside", 60, { status: "resolved", resolvedAt: minutesAgo(15) });
    assert.equal(incidentToReopen([archived, older], trip, now)?.id, "inc_older_inside");
  });

  it("matches the route in the title on incidents from before it was recorded", () => {
    const older = incident("inc_older", 50, { status: "resolved", resolvedAt: minutesAgo(10) });
    delete older.trigger.route;
    assert.equal(incidentToReopen([older], trip, now)?.id, "inc_older");
    assert.equal(incidentToReopen([older], { ...trip, route: "/api/products/[id]" }, now), undefined);
  });
});
