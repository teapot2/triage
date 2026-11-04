import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultRules, slowMetric, tripMetric, type WatchCondition, type WatchRule } from "./watch-rule-model";

const rule = (condition: WatchCondition): WatchRule => ({ ...defaultRules[1], condition });

// What an incident from each kind of rule charts, recovers and verifies on:
// the rule's own measure, against the rule's own limit.
describe("tripMetric", () => {
  it("charts a p95 rule's route p95 against its latency limit", () => {
    assert.deepEqual(tripMetric(rule({ metric: "p95", aboveMs: 500 }), "/api/products/[id]"), {
      metric: "http.server.request.duration.p95{route=/api/products/[id]}",
      threshold: 500,
    });
  });

  it("charts a slow-request count per minute against the count, not the route's p95", () => {
    assert.deepEqual(tripMetric(rule({ metric: "slowCount", slowerThanMs: 1500, moreThan: 3 }), "/"), {
      metric: "http.server.slow_requests{route=/,le=1500}",
      threshold: 3,
    });
  });

  it("charts a slow-request share per minute, in percent, against the share", () => {
    assert.deepEqual(tripMetric(rule({ metric: "slowShare", slowerThanMs: 800, moreThanPercent: 10 }), "/cart"), {
      metric: "http.server.slow_share{route=/cart,le=800}",
      threshold: 10,
    });
  });

  it("charts an error-rate rule's error ratio against the limit as a ratio", () => {
    assert.deepEqual(tripMetric(rule({ metric: "errorRate", moreThanPercent: 5 }), "/api/x"), {
      metric: "http.server.error_ratio{route=/api/x}",
      threshold: 0.05,
    });
  });

  it("charts an SLO's burn rate against the burn that fired", () => {
    const slo = rule({ metric: "slo", objectivePercent: 99.9, windowDays: 30, latencyMs: 500 });
    assert.deepEqual(tripMetric(slo, "/api/x", 14.4), { metric: "slo.burn_rate{route=/api/x,objective=99.9,le=500}", threshold: 14.4 });
  });

  it("names the slow series with the route and the limit the live source reads back", () => {
    assert.equal(slowMetric("count", "/products/[id]", 1000), "http.server.slow_requests{route=/products/[id],le=1000}");
    assert.equal(slowMetric("share", "/", 250), "http.server.slow_share{route=/,le=250}");
  });
});
