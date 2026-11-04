import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RequestSample } from "./live/live-source";
import { backtestRule } from "./watch-judge";
import { defaultRules, type WatchRule } from "./watch-rule-model";

// The default Page latency rule replayed, as the watch judges it every 10 s,
// over shapes taken from Shopfront's telemetry on Nov 3 and 4 2026: each
// shape is one route's requests per 10 s, [requests, slower than 1500 ms].

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const pageRule = defaultRules.find((r) => r.id === "page-latency")!;
// What it was until Nov 4 2026: more than 3 for 2 checks.
const before: WatchRule = { ...pageRule, condition: { metric: "slowCount", slowerThanMs: 1500, moreThan: 3 }, checksToOpen: 2 };

// One route's requests from `from`, spread evenly over each 10 s, the slow
// ones taking `slowMs` and the rest 300 ms.
function requests(route: string, from: number, shape: [number, number][], slowMs: number): RequestSample[] {
  return shape.flatMap(([n, slow], i) =>
    Array.from({ length: n }, (_, j) => {
      const start = from + i * 10 * SECOND + Math.floor(((j + 0.5) * 10 * SECOND) / n);
      return {
        service: "shopfront",
        route,
        method: "GET",
        start,
        durationMs: j < slow ? slowMs : 300,
        status: 200,
        failed: false,
        traceId: `${route}-${start}-${j}`,
      };
    }),
  );
}

const replay = (rule: WatchRule, samples: RequestSample[], from: number, length: number) =>
  backtestRule(rule, samples, from, from + length * 10 * SECOND);

// Per minute up to `at`, how many of the route's requests were slower than
// 1500 ms: what the incident's chart shows when it opens.
function chart(samples: RequestSample[], at: number): number[] {
  const end = Math.floor(at / MINUTE) * MINUTE;
  return [3, 2, 1, 0].map((back) => {
    const start = end - back * MINUTE;
    return samples.filter((s) => s.start >= start && s.start < start + MINUTE && s.start <= at && s.durationMs > 1500).length;
  });
}

describe("the default Page latency rule", () => {
  it("doesn't page on a dev server's first renders after it sat idle", () => {
    // Nov 4 02:34:00 to 02:37:00, /products/[id]: traffic back after 25
    // idle minutes, 1 slow render at 02:34:5x and 3 at 02:35:3x. The rolling
    // minute held 4 for two checks, and the incident it opened charted 1
    // and 3 a minute.
    const from = Date.parse("2026-11-04T02:34:00.000Z");
    const shape: [number, number][] = [
      [0, 0], [0, 0], [0, 0], [11, 0], [3, 0], [9, 1], [3, 0], [9, 0], [13, 0],
      [13, 3], [14, 0], [6, 0], [2, 0], [3, 0], [5, 0], [5, 0], [2, 0], [8, 0],
    ];
    const samples = requests("/products/[id]", from, shape, 2500);
    assert.deepEqual(replay(pageRule, samples, from, shape.length).fired, []);
    assert.equal(replay(before, samples, from, shape.length).fired.length, 1);
  });

  it("doesn't page on the odd slow render after a fault is turned off", () => {
    // Nov 4 02:03 to 02:07 on /products/[id] (3, 3, 4 and 2 a minute) and
    // 02:08:30 to 02:11 on / (7 then 4), after the pool leak's flag went off
    // at 02:03: each opened an incident of its own.
    const products = Date.parse("2026-11-04T02:03:00.000Z");
    const productsShape: [number, number][] = [
      [17, 3], [25, 0], [14, 0], [19, 0], [8, 0], [16, 0], [11, 0], [16, 0], [18, 0], [9, 0], [7, 0], [11, 3],
      [12, 2], [11, 2], [11, 0], [12, 0], [5, 0], [5, 0], [8, 2], [3, 0], [8, 0], [11, 0], [10, 0], [6, 0],
    ];
    const home = Date.parse("2026-11-04T02:08:30.000Z");
    const homeShape: [number, number][] = [
      [3, 0], [1, 0], [5, 0], [4, 0], [1, 0], [5, 0], [3, 0], [9, 4], [6, 3], [3, 1], [4, 1], [2, 1], [4, 1], [5, 0], [3, 0],
    ];
    for (const [route, from, shape] of [
      ["/products/[id]", products, productsShape],
      ["/", home, homeShape],
    ] as const) {
      const samples = requests(route, from, [...shape], 2500);
      assert.deepEqual(replay(pageRule, samples, from, shape.length).fired, [], route);
      assert.equal(replay(before, samples, from, shape.length).fired.length, 1, route);
    }
  });

  it("pages on the pool leak within 2 minutes, with its chart past the limit", () => {
    // Nov 4 02:00 to 02:03, /products/[id]: the leak from 02:01:30, every
    // request waiting about 6 s for a connection.
    const from = Date.parse("2026-11-04T02:00:00.000Z");
    const shape: [number, number][] = [
      [7, 0], [7, 0], [10, 0], [4, 0], [10, 0], [10, 0], [13, 0], [11, 0], [10, 0],
      [15, 4], [6, 6], [11, 11], [12, 12], [11, 11], [6, 6], [6, 6], [13, 13], [12, 12],
    ];
    const samples = requests("/products/[id]", from, shape, 6000);
    const { fired } = replay(pageRule, samples, from, shape.length);
    assert.equal(fired.length, 1);
    const at = Date.parse(fired[0].at);
    const onset = Date.parse("2026-11-04T02:01:30.000Z");
    assert.ok(at - onset <= 2 * MINUTE, `opened ${(at - onset) / SECOND} s after the leak started`);
    assert.ok(Math.max(...chart(samples, at)) > 10, `chart ${chart(samples, at)}`);
  });

  it("pages on a leak turned off after 70 seconds", () => {
    // Nov 3 23:27 to 23:29:40, /products/[id]: slow from 23:28:00 to
    // 23:29:10, when the flag went off.
    const from = Date.parse("2026-11-03T23:27:00.000Z");
    const shape: [number, number][] = [
      [5, 0], [6, 0], [9, 1], [13, 2], [11, 0], [11, 0], [9, 3], [8, 8],
      [4, 4], [6, 6], [7, 7], [7, 7], [6, 6], [9, 5], [8, 0], [11, 0],
    ];
    const samples = requests("/products/[id]", from, shape, 6000);
    const { fired } = replay(pageRule, samples, from, shape.length);
    assert.equal(fired.length, 1);
    assert.ok(Math.max(...chart(samples, Date.parse(fired[0].at))) > 10);
  });

  it("pages on a page slow for minutes with no fault on", () => {
    // Nov 4 01:22:20 to 01:26, /products/[id]: the dev server busy (event
    // loop 75% used, against about 20% in the pool leak) and 28, 15 and 15
    // renders a minute over 1500 ms, not first visits. As slow as the leak's
    // first minute for longer than it lasted: a slowdown people saw.
    const from = Date.parse("2026-11-04T01:22:20.000Z");
    const shape: [number, number][] = [
      [2, 0], [7, 0], [15, 0], [12, 1], [11, 3], [13, 7], [13, 8], [13, 2], [16, 2], [11, 6], [13, 2],
      [12, 4], [5, 0], [8, 4], [13, 3], [13, 2], [13, 0], [7, 0], [9, 3], [9, 3], [9, 4], [16, 5],
    ];
    const samples = requests("/products/[id]", from, shape, 2500);
    const { fired } = replay(pageRule, samples, from, shape.length);
    assert.equal(fired.length, 1);
    assert.ok(Math.max(...chart(samples, Date.parse(fired[0].at))) > 10);
  });
});
