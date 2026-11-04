import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveFlagStates } from "../source";
import { pastThreshold } from "../recovery";
import { evaluateRule } from "../watch-judge";
import { defaultRules, slowMetric, tripMetric } from "../watch-rule-model";
import {
  deployRecords,
  fetchRelease,
  flagEvents,
  flagStates,
  gitLogArgs,
  harnessPaths,
  listSourceFiles,
  p95,
  requestSamples,
  shopfrontDir,
  slowSeries,
} from "./live-source";
import type { LogRow, SpanRow } from "./otlp-files";

const at = (iso: string) => Date.parse(iso);
const warn = (time: string, body: string, attributes: LogRow["attributes"] = {}): LogRow => ({
  time: at(time),
  service: "shopfront",
  level: "warn",
  body,
  attributes,
});

const flagOn = warn("2026-11-01T12:00:00Z", "ops: FF_LIST_PRICES turned on", { "flag.name": "FF_LIST_PRICES" });
const deployed = warn("2026-11-01T12:05:00Z", "deploy: 9f3c2a1 feat(shopfront): return a formatted price from the product API", {
  "deploy.sha": "9f3c2a1",
  "deploy.message": "feat(shopfront): return a formatted price from the product API",
  "deploy.kind": "deploy",
  "deploy.branch": "shopfront-release/formatted-price",
});
const rolledBack = warn("2026-11-01T12:20:00Z", "deploy: rolled back 9f3c2a1", {
  "deploy.sha": "9f3c2a1",
  "deploy.kind": "rollback",
  "deploy.previous": "e50f949",
});

describe("deployRecords", () => {
  it("maps flag flips as before: a config record per ops warning, newest first", () => {
    const earlier = warn("2026-11-01T11:00:00Z", "ops: FF_LIVE_RATINGS turned off", { "flag.name": "FF_LIVE_RATINGS" });
    assert.deepEqual(deployRecords([earlier, flagOn]), [
      { service: "shopfront", sha: "config:FF_LIST_PRICES", deployedAt: "2026-11-01T12:00:00.000Z", kind: "config", message: "ops: FF_LIST_PRICES turned on" },
      { service: "shopfront", sha: "config:FF_LIVE_RATINGS", deployedAt: "2026-11-01T11:00:00.000Z", kind: "config", message: "ops: FF_LIVE_RATINGS turned off" },
    ]);
  });

  it("maps a deploy warning to a deploy record with its sha, message and branch", () => {
    assert.deepEqual(deployRecords([deployed]), [
      {
        service: "shopfront",
        sha: "9f3c2a1",
        deployedAt: "2026-11-01T12:05:00.000Z",
        kind: "deploy",
        message: "feat(shopfront): return a formatted price from the product API",
        branch: "shopfront-release/formatted-price",
      },
    ]);
  });

  it("maps a rollback warning to a rollback record naming the sha rolled back", () => {
    const [r] = deployRecords([rolledBack]);
    assert.deepEqual(r, {
      service: "shopfront",
      sha: "9f3c2a1",
      deployedAt: "2026-11-01T12:20:00.000Z",
      kind: "rollback",
      message: "deploy: rolled back 9f3c2a1",
    });
  });

  it("ignores other services, levels and bodies", () => {
    const noise: LogRow[] = [
      { ...flagOn, service: "postgres" },
      { ...flagOn, level: "info" },
      warn("2026-11-01T12:01:00Z", "fetched product", { "product.id": 3 }),
    ];
    assert.deepEqual(deployRecords(noise), []);
    assert.deepEqual(
      deployRecords([flagOn, ...noise, deployed, rolledBack]).map((r) => r.kind),
      ["rollback", "deploy", "config"],
    );
  });
});

describe("flagStates", () => {
  const loaded = (time: string, flags: Record<string, boolean>): LogRow => ({
    time: at(time),
    service: "shopfront",
    level: "info",
    body: "flags: loaded",
    attributes: Object.fromEntries(Object.entries(flags).map(([k, v]) => [`flag.${k}`, v])),
  });
  const flip = (time: string, flag: string, on: boolean) => warn(time, `ops: ${flag} turned ${on ? "on" : "off"}`, { "flag.name": flag });
  const boot = loaded("2026-11-01T11:00:00Z", { FF_STOCK_DIRECT_QUERY: false, FF_LIST_PRICES: false, FF_LIVE_RATINGS: false });

  it("starts from the newest boot line and applies the flips after it, whatever order the rows come in", () => {
    const rows = [
      flip("2026-11-01T11:30:00Z", "FF_LIST_PRICES", true),
      // An earlier boot and the flips before it say nothing about now.
      loaded("2026-11-01T09:00:00Z", { FF_LIVE_RATINGS: true }),
      flip("2026-11-01T10:00:00Z", "FF_STOCK_DIRECT_QUERY", true),
      boot,
      flip("2026-11-01T11:10:00Z", "FF_LIVE_RATINGS", true),
      flip("2026-11-01T11:20:00Z", "FF_LIVE_RATINGS", false),
    ];
    assert.deepEqual(deriveFlagStates(flagEvents(rows)), { FF_STOCK_DIRECT_QUERY: false, FF_LIST_PRICES: true, FF_LIVE_RATINGS: false });
    assert.deepEqual(flagStates(rows), deriveFlagStates(flagEvents(rows)));
  });

  it("with no boot line, a flag's last flip decides it and the rest are unknown", () => {
    const rows = [flip("2026-11-01T12:00:00Z", "FF_LIST_PRICES", true), flip("2026-11-01T12:01:00Z", "FF_LIST_PRICES", false), flip("2026-11-01T11:00:00Z", "FF_LIVE_RATINGS", true)];
    assert.deepEqual(flagStates(rows), { FF_LIST_PRICES: false, FF_LIVE_RATINGS: true });
  });

  it("says nothing from logs that mention no flag", () => {
    assert.deepEqual(flagStates([]), {});
    assert.deepEqual(flagStates([deployed, rolledBack, warn("2026-11-01T12:01:00Z", "fetched product", { "product.id": 3 })]), {});
    // Another service's flags are not Shopfront's.
    assert.deepEqual(flagStates([{ ...boot, service: "postgres" }]), {});
  });
});

describe("fetchRelease", () => {
  const ok = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

  it("returns the deployed release", async () => {
    const release = { name: "formatted-price", sha: "9f3c2a1", branch: "shopfront-release/formatted-price", message: "feat", deployedAt: "2026-11-01T12:05:00Z", previous: "e50f949" };
    assert.deepEqual(await fetchRelease(ok({ flags: [], release }), "http://ops.test/api/ops"), release);
  });

  it("is undefined with no release, an older ops API, a 404, or no answer", async () => {
    assert.equal(await fetchRelease(ok({ flags: [], release: null })), undefined);
    assert.equal(await fetchRelease(ok({ flags: [] })), undefined);
    assert.equal(await fetchRelease((async () => new Response("", { status: 404 })) as unknown as typeof fetch), undefined);
    assert.equal(await fetchRelease((async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch), undefined);
  });
});

describe("gitLogArgs", () => {
  // The command before releases existed: HEAD's log with the harness left out.
  const before = (file: string | undefined, limit: number) => [
    "-C",
    shopfrontDir,
    "log",
    `-n${limit}`,
    "--name-only",
    "--format=%x1e%h%x1f%an%x1f%s%x1f%cI",
    "--relative",
    "--",
    file ?? ".",
    ...harnessPaths.map((h) => `:(exclude)${h}`),
  ];

  it("runs the same command as before when no release is deployed", () => {
    assert.deepEqual(gitLogArgs({ limit: 10 }), before(undefined, 10));
    assert.deepEqual(gitLogArgs({ limit: 5, path: "src/lib/prices.ts" }), before("src/lib/prices.ts", 5));
    assert.deepEqual(gitLogArgs({ limit: 5, from: undefined }), before(undefined, 5));
  });

  it("logs from the release's sha when one is deployed", () => {
    const args = gitLogArgs({ limit: 10, from: "9f3c2a1" });
    assert.deepEqual(args.slice(0, 7), before(undefined, 10).slice(0, 7));
    assert.deepEqual(args.slice(7), ["9f3c2a1", ...before(undefined, 10).slice(7)]);
  });

  it("excludes the release harness", () => {
    for (const h of ["src/lib/releases.ts", "releases/", "scripts/release.ts"]) {
      assert.ok(harnessPaths.includes(h), `${h} is not a harness path`);
      assert.ok(gitLogArgs({ limit: 1 }).includes(`:(exclude)${h}`));
    }
  });
});

describe("listSourceFiles", () => {
  it("never lists the release harness", async () => {
    const files = await listSourceFiles();
    const shown = files.filter((f) => f === "src/lib/releases.ts" || f === "scripts/release.ts" || f.startsWith("releases/"));
    assert.deepEqual(shown, []);
  });

  it("never lists a harness file's test either", async () => {
    const files = await listSourceFiles();
    assert.ok(files.includes("src/lib/products.ts"));
    assert.deepEqual(files.filter((f) => /^src\/lib\/traffic(-profile)?\.test\.ts$/.test(f)), []);
  });
});

describe("slowSeries", () => {
  const MINUTE = 60_000;
  const now = Date.parse("2026-11-03T12:02:30.000Z");
  // Minutes from 12:00: a request on `route` starting `offset` ms in, taking `ms`.
  let n = 0;
  const span = (minute: number, ms: number, o: { route?: string; method?: string } = {}): SpanRow => {
    const start = Date.parse("2026-11-03T12:00:00.000Z") + minute * MINUTE + ++n;
    const method = o.method ?? "GET";
    return {
      traceId: `t${n}`,
      spanId: `s${n}`,
      service: "shopfront",
      scope: "next.js",
      name: `${method} ${o.route ?? "/"}`,
      kind: 2,
      start,
      end: start + ms,
      error: false,
      attributes: { "http.route": o.route ?? "/", "http.method": method, "http.status_code": 200 },
      events: [],
    };
  };
  const f = { duration: (s: SpanRow) => s.end - s.start };
  const fast = (minute: number, count: number) => Array.from({ length: count }, () => span(minute, 200));

  it("counts each minute's requests slower than the limit, 0 when none are, and skips a minute with none", () => {
    const spans = [
      // 12:00: 5 slow of 7. 12:01: no requests at all. 12:02: 12 fast.
      ...[1600, 2000, 4000, 1501, 9000].map((ms) => span(0, ms)),
      span(0, 1500), // exactly the limit isn't slower than it
      span(0, 100),
      ...fast(2, 12),
      // Not counted: another route, and a HEAD probe.
      span(0, 5000, { route: "/cart" }),
      span(0, 5000, { method: "HEAD" }),
    ];
    const series = slowSeries("http.server.slow_requests{route=/,le=1500}", spans, now, f)!;
    assert.equal(series.unit, "requests");
    assert.deepEqual(series.points(3), [
      { t: "2026-11-03T12:00:00.000Z", value: 5 },
      { t: "2026-11-03T12:02:00.000Z", value: 0 },
    ]);
    const share = slowSeries("http.server.slow_share{route=/,le=1500}", spans, now, f)!;
    assert.equal(share.unit, "%");
    assert.deepEqual(share.points(3), [
      { t: "2026-11-03T12:00:00.000Z", value: 71.43 },
      { t: "2026-11-03T12:02:00.000Z", value: 0 },
    ]);
  });

  it("serves the series a slow-request rule's incident charts, for any route", () => {
    const spans = [span(0, 3000, { route: "/products/[id]" }), span(0, 50, { route: "/products/[id]" })];
    const name = slowMetric("count", "/products/[id]", 1000);
    assert.equal(name, "http.server.slow_requests{route=/products/[id],le=1000}");
    assert.deepEqual(slowSeries(name, spans, now, f)!.points(3), [{ t: "2026-11-03T12:00:00.000Z", value: 1 }]);
    assert.deepEqual(slowSeries(slowMetric("share", "/products/[id]", 1000), spans, now, f)!.points(3), [
      { t: "2026-11-03T12:00:00.000Z", value: 50 },
    ]);
  });

  it("answers only to a slow-request name", () => {
    assert.equal(slowSeries("http.server.request.duration.p95{route=/}", [], now, f), undefined);
    assert.equal(slowSeries("http.server.slow_requests{route=/}", [], now, f), undefined);
    assert.equal(slowSeries("slo.burn_rate{route=/,objective=99,le=500}", [], now, f), undefined);
  });

  // The live rehearsal: after the flag-off a dev-mode page still has the odd
  // slow request, which moves a p95 over ~15 requests a minute past the
  // limit, but by the rule's own measure the page has recovered.
  it("judges a Page latency incident as the watch judged the rule, not on p95", () => {
    const rule = defaultRules.find((r) => r.id === "page-latency")!;
    const { metric, threshold } = tripMetric(rule, "/");
    assert.deepEqual({ metric, threshold }, { metric: "http.server.slow_requests{route=/,le=1500}", threshold: 10 });
    const minute = (slow: number) => [...Array.from({ length: slow }, () => 4000), ...Array.from({ length: 14 - slow }, () => 300)];
    // 12:00 the leak (12 slow), 12:01 one slow request, 12:02 ten.
    const spans = [0, 1, 2].flatMap((m) => minute([12, 1, 10][m]).map((ms) => span(m, ms)));
    const points = slowSeries(metric, spans, now, f)!.points(3);
    const past = pastThreshold(metric, threshold);
    assert.deepEqual(
      points.map((p) => [p.value, past(p.value)]),
      [
        [12, true],
        [1, false],
        [10, false],
      ],
    );
    // The same minutes' p95 is past the slow limit throughout.
    for (const m of [0, 1, 2]) assert.ok(p95(minute([12, 1, 10][m])) > 1500);
    // And the watch, judging each minute's requests, agrees with the series.
    for (const m of [0, 1, 2]) {
      const end = Date.parse("2026-11-03T12:00:00.000Z") + (m + 1) * MINUTE - 1;
      const samples = requestSamples(spans, end - MINUTE, end);
      const r = evaluateRule({ ...rule, windowSeconds: 60 }, samples, end, new Map());
      assert.equal(r.status === "breaching", past(points[m].value));
    }
  });
});
