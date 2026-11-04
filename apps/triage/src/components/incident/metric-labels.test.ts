import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exclusiveLimit, limitSides, limitText, metricLabel, pastLimit } from "./metric-labels";

const count = "http.server.slow_requests{route=/,le=1500}";
const share = "http.server.slow_share{route=/cart,le=800}";
const p95 = "http.server.request.duration.p95{route=/}";
const availability = "uptime.availability{check=chk_abc123}";

describe("slow-request metrics", () => {
  it("read as what the rule counts, on its route", () => {
    assert.equal(metricLabel(count), "Requests over 1500 ms · /");
    assert.equal(metricLabel(share), "Share of requests over 800 ms · /cart");
    assert.equal(metricLabel("http.server.slow_requests"), "Slow requests");
  });

  it("have a 'more than N' limit: breached past it, healthy at it", () => {
    assert.ok(exclusiveLimit(count) && exclusiveLimit(share));
    assert.ok(!exclusiveLimit(p95) && !exclusiveLimit(availability));
    assert.deepEqual([3, 4].map(pastLimit(count, 3)), [false, true]);
    assert.deepEqual([10, 10.5].map(pastLimit(share, 10)), [false, true]);
    assert.deepEqual(limitSides(count), { healthy: "at or under", breach: "over" });
    assert.equal(limitText(count, "3 requests"), "more than 3 requests");
  });

  it("leave the other metrics as they were", () => {
    assert.equal(metricLabel(p95), "p95 latency · /");
    assert.deepEqual([499, 500].map(pastLimit(p95, 500)), [false, true]);
    assert.deepEqual([100, 99.9].map(pastLimit(availability, 100)), [false, true]);
    assert.deepEqual(limitSides(p95), { healthy: "under", breach: "over" });
    assert.deepEqual(limitSides(availability), { healthy: "at or over", breach: "under" });
    assert.equal(limitText(p95, "500 ms"), "500 ms");
  });
});
