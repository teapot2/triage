import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { investigationOptions } from "../options";
import { QuestionRecorder } from "../recorder";
import type { Hypothesis, InvestigationReport, Mitigation, Question } from "../schema";
import type { DbCheck } from "../source";
import { createInvestigationTools } from "../tools";
import { getScenario, scenarios } from ".";
import { grade } from "./grade";
import { createScenarioSource, type Scenario } from "./scenario-source";

const sentinel = "GROUND_TRUTH_SENTINEL_7f3a";

// The scenario with ground truth no real telemetry could contain.
const marked = (s: Scenario): Scenario => ({
  ...s,
  expected: {
    verdict: "root_cause",
    rootCauseFiles: [`src/${sentinel}.ts`],
    mustMention: [[sentinel]],
    mitigation: { kind: "flag_off", target: sentinel },
  },
});

// Everything a model can get from a scenario: the description its prompt
// is built from, the tools' descriptions, and every query answered as
// broadly as the source allows.
async function everythingVisible(s: Scenario): Promise<string> {
  const source = createScenarioSource(s);
  const d = source.describe();
  const question: Question = {
    id: "q_1",
    text: "",
    askedAt: s.now,
    status: "answering",
    answer: "",
    citedIds: [],
    unknownIds: [],
    steps: [],
    evidence: [],
    mode: "tools",
    model: "test",
  };
  const tools = createInvestigationTools(source, new QuestionRecorder(question, "inc_test", "shopfront", async () => {}), {
    submit: false,
  });
  const files = await source.listSourceFiles();
  const parts: unknown[] = [
    d,
    Object.values(tools).map((t) => t.description),
    await source.queryLogs({ windowMinutes: 1e6 }),
    await source.queryTraces({ limit: 1e6 }),
    await Promise.all(d.metrics.map((m) => source.queryMetric({ name: m.name, windowMinutes: 1e6 }))),
    await Promise.all((["activity", "locks", "slow_queries"] as DbCheck[]).map((c) => source.dbDiagnostics(c))),
    files,
    await Promise.all(files.map((f) => source.readSource(f))),
    await source.gitLog({ limit: 1e6 }),
    await source.deployHistory({ sinceMinutes: 1e9 }),
    s.alert,
  ];
  return JSON.stringify(parts);
}

describe("scenario ground truth", () => {
  for (const s of scenarios) {
    it(`${s.id} has ground truth`, () => {
      assert.ok(s.expected, `${s.id} has no expected`);
    });

    it(`${s.id}'s ground truth never reaches the model`, async () => {
      const visible = await everythingVisible(marked(s));
      assert.ok(!visible.includes(sentinel), "the sentinel leaked");
      assert.ok(!/"expected"|mustMention|rootCauseFiles/.test(visible), "a ground-truth field name leaked");
    });
  }

  it("the investigation menu offers only id, label and description", () => {
    for (const o of investigationOptions.filter((o) => !o.live)) {
      assert.deepEqual(Object.keys(o).sort(), ["description", "id", "label"]);
    }
  });
});

describe("price-gap scenario", () => {
  const s = getScenario("price-gap")!;
  const source = createScenarioSource(s);

  it("is offered in the investigation menu", () => {
    assert.ok(investigationOptions.some((o) => o.id === "price-gap" && o.label === "Price list gap"));
  });

  it("fires its alert: the series' last point is over the threshold", async () => {
    const alert = await source.queryMetric({ name: s.alert.metric, windowMinutes: 30 });
    assert.ok(alert && alert.points.length > 0);
    assert.ok(alert.points.at(-1)!.value > s.alert.threshold);
    assert.ok(alert.points.slice(0, -1).every((p) => p.value <= s.alert.threshold));
  });

  it("recovers right after the flag goes off", () => {
    assert.ok(s.recovery!.length > 0);
    assert.ok(s.recovery![0].value < s.alert.threshold);
  });

  it("serves the code and history the diagnosis needs", async () => {
    const prices = await source.readSource("src/lib/prices.ts");
    assert.match(prices!.content, /isEnabled\("FF_LIST_PRICES"\)/);
    assert.match(prices!.content, /innerJoin\(stockLevels/);
    const [flag] = await source.deployHistory({ sinceMinutes: 5 });
    assert.equal(flag.sha, "config:FF_LIST_PRICES");
    assert.equal(flag.message, "ops: FF_LIST_PRICES turned on");
    const commits = await source.gitLog({ path: "src/lib/prices.ts", limit: 5 });
    assert.deepEqual(
      commits.map((c) => c.message),
      ["feat: serve list prices from the price list"],
    );
  });

  it("keeps the pool and latency at baseline", async () => {
    const used = await source.queryMetric({ name: "db.client.connection.count{state=used}", windowMinutes: 45 });
    assert.ok(used!.points.every((p) => p.value <= 2));
    const p95 = await source.queryMetric({ name: "http.server.request.duration.p95{route=/api/products/[id]}", windowMinutes: 45 });
    assert.ok(p95!.points.every((p) => p.value < 500));
  });
});

describe("live-ratings scenario", () => {
  const s = getScenario("live-ratings")!;
  const source = createScenarioSource(s);

  it("is offered in the investigation menu", () => {
    assert.ok(investigationOptions.some((o) => o.id === "live-ratings" && o.label === "Live ratings"));
  });

  it("fires its alert: the last point is over the threshold, the minutes before the flag mostly under", async () => {
    const alert = await source.queryMetric({ name: s.alert.metric, windowMinutes: 45 });
    assert.ok(alert && alert.points.length > 0);
    assert.ok(alert.points.at(-1)!.value > s.alert.threshold);
    const over = alert.points.slice(0, -1).filter((p) => p.value > s.alert.threshold);
    assert.ok(over.length <= 2, `${over.length} earlier minutes over the threshold`);
  });

  it("recovers right after the flag goes off", () => {
    assert.ok(s.recovery!.length > 0);
    assert.ok(s.recovery![0].value < s.alert.threshold);
  });

  it("shows a query per product on the slow listings, two before the flag", async () => {
    const spans = (await source.queryTraces({ service: "shopfront", route: "/api/products", limit: 50 })).filter(
      (sp) => sp.route === "/api/products",
    );
    const slow = spans.filter((sp) => sp.durationMs > s.alert.threshold);
    assert.ok(slow.length > 0 && slow.every((sp) => sp.attributes["db.queries"] === 16));
    assert.ok(spans.some((sp) => sp.durationMs < 100 && sp.attributes["db.queries"] === 2));
    const reviews = await source.queryTraces({ service: "postgres", route: "reviews", limit: 50 });
    assert.equal(reviews.length, 15);
  });

  it("serves the code and history the diagnosis needs", async () => {
    const ratings = await source.readSource("src/lib/ratings.ts");
    assert.match(ratings!.content, /isEnabled\("FF_LIVE_RATINGS"\)/);
    assert.match(ratings!.content, /for \(const id of productIds\)/);
    const schema = await source.readSource("src/db/schema.ts");
    assert.match(schema!.content, /reviews_product_id_idx/);
    const [flag] = await source.deployHistory({ sinceMinutes: 5 });
    assert.equal(flag.sha, "config:FF_LIVE_RATINGS");
    assert.equal(flag.message, "ops: FF_LIVE_RATINGS turned on");
  });

  it("keeps the pool and errors at baseline", async () => {
    const used = await source.queryMetric({ name: "db.client.connection.count{state=used}", windowMinutes: 45 });
    assert.ok(used!.points.every((p) => p.value <= 2));
    const errors = await source.queryMetric({ name: "http.server.error_ratio", windowMinutes: 45 });
    assert.ok(errors!.points.every((p) => p.value === 0));
  });

  it("leaves the sandbox's own table copy out of the slow queries", async () => {
    const { rows } = await source.dbDiagnostics("slow_queries");
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => !String(r.query).includes("json_agg")));
  });
});

describe("bad-deploy scenario", () => {
  const s = getScenario("bad-deploy")!;
  const source = createScenarioSource(s);
  const typeError = "Currency code is required with currency style.";

  it("is offered in the investigation menu", () => {
    assert.ok(investigationOptions.some((o) => o.id === "bad-deploy" && o.label === "Bad deploy (formatted price)"));
  });

  it("fires its alert: the series' last point is over the threshold", async () => {
    const alert = await source.queryMetric({ name: s.alert.metric, windowMinutes: 30 });
    assert.ok(alert && alert.points.length > 0);
    assert.ok(alert.points.at(-1)!.value > s.alert.threshold);
    assert.ok(alert.points.slice(0, -1).every((p) => p.value <= s.alert.threshold));
  });

  it("recovers right after the rollback", () => {
    assert.ok(s.recovery!.length > 0);
    assert.ok(s.recovery![0].value < s.alert.threshold);
  });

  it("answers the deploy history with the release first, the flag flips as decoys", async () => {
    const [deploy] = await source.deployHistory({ sinceMinutes: 5 });
    assert.equal(deploy.sha, "0dfdbac");
    assert.equal(deploy.kind, "deploy");
    assert.equal(deploy.branch, "shopfront-release/formatted-price");
    assert.equal(deploy.message, "feat(shopfront): return a formatted price from the product API");
    const hour = await source.deployHistory({ sinceMinutes: 60 });
    assert.deepEqual(
      hour.map((d) => `${d.kind} ${d.sha}`),
      ["deploy 0dfdbac", "config config:FF_LIST_PRICES", "config config:FF_LIST_PRICES"],
    );
    assert.ok(hour.every((d) => d.kind !== "rollback"), "no earlier rollback of the release");
  });

  it("serves the release's code and history", async () => {
    const money = await source.readSource("src/lib/money.ts");
    assert.match(money!.content, /currency = process\.env\.STORE_CURRENCY/);
    assert.match(money!.content, /new Intl\.NumberFormat\("en-US", \{ style: "currency", currency \}\)/);
    const route = await source.readSource("src/app/api/products/[id]/route.ts");
    assert.match(route!.content, /import \{ formatPrice \} from "@\/lib\/money"/);
    assert.match(route!.content, /price: formatPrice\(priceCents\)/);
    const commits = await source.gitLog({ path: "src/lib/money.ts", limit: 5 });
    assert.deepEqual(
      commits.map((c) => c.sha),
      ["0dfdbac"],
    );
    const [newest] = await source.gitLog({ limit: 1 });
    assert.equal(newest.sha, "0dfdbac");
    assert.deepEqual(newest.files, ["src/app/api/products/[id]/route.ts", "src/lib/money.ts"]);
  });

  it("logs the exception and the failed requests only since the deploy", async () => {
    const errors = await source.queryLogs({ service: "shopfront", minLevel: "error", windowMinutes: 45 });
    assert.ok(errors.length > 0);
    assert.ok(errors.every((l) => l.message.includes(typeError) || l.message.includes(" 500 ")));
    assert.ok(errors.every((l) => Date.parse(l.firstSeen) > Date.parse("2026-11-02T06:27:57.790Z")));
    const failing = await source.queryTraces({ service: "shopfront", route: "/api/products/[id]", status: "error", limit: 10 });
    assert.ok(failing.length >= 3);
    assert.ok(failing.every((sp) => sp.attributes["exception.message"] === typeError && sp.attributes["db.queries"] === 2));
    const listing = await source.queryTraces({ service: "shopfront", route: "/api/products", status: "error", limit: 10 });
    assert.equal(listing.filter((sp) => sp.route === "/api/products").length, 0);
  });

  it("keeps the pool and latency at baseline", async () => {
    const used = await source.queryMetric({ name: "db.client.connection.count{state=used}", windowMinutes: 45 });
    assert.ok(used!.points.every((p) => p.value <= 1));
    const p95 = await source.queryMetric({ name: "http.server.request.duration.p95{route=/api/products/[id]}", windowMinutes: 45 });
    assert.ok(p95!.points.every((p) => p.value < 500));
    const listErrors = await source.queryMetric({ name: "http.server.error_ratio{route=/api/products}", windowMinutes: 45 });
    assert.ok(listErrors!.points.every((p) => p.value === 0));
  });

  it("grades a right diagnosis with a rollback as a hit", () => {
    const text =
      "Release 0dfdbac added formatPrice in src/lib/money.ts, which calls Intl.NumberFormat in currency style with the currency from STORE_CURRENCY; it is unset, so every call throws.";
    const leading: Hypothesis = {
      id: "h1",
      title: "formatPrice throws without STORE_CURRENCY",
      confidence: 0.9,
      status: "leading",
      causalChain: {
        symptom: { text: "Every GET /api/products/[id] answers 500 since 06:27:59", evidenceIds: ["ev_metric_1"] },
        propagation: { text: "The handler throws a TypeError formatting the price", evidenceIds: ["ev_log_1"] },
        rootCause: { text, evidenceIds: ["ev_source_1"] },
      },
    };
    const report: InvestigationReport = {
      hypotheses: [leading],
      verdict: { kind: "root_cause", hypothesisId: "h1" },
      servicesQueried: ["shopfront"],
    };
    const rollback: Mitigation = {
      kind: "rollback",
      target: "0dfdbac",
      title: "Roll back shopfront to the deploy before 0dfdbac",
      why: { text: "The symptom began after 0dfdbac was deployed.", evidenceIds: ["ev_commit_1"] },
      steps: [],
      undo: "",
      risk: "low",
      state: "proposed",
      proposedAt: s.now,
    };
    const hit = grade(report, rollback, s.expected!);
    assert.equal(hit.hit, true, hit.reasons.join("; "));
    assert.ok(hit.reasons.includes("mitigation rollback 0dfdbac"));
    const flag = grade(report, { ...rollback, kind: "flag_off", target: "FF_LIST_PRICES" }, s.expected!);
    assert.deepEqual(flag.reasons, ["mitigation flag_off FF_LIST_PRICES, expected rollback 0dfdbac"]);
  });
});

describe("traffic-rush scenario", () => {
  const s = getScenario("traffic-rush")!;
  const source = createScenarioSource(s);

  it("is offered in the investigation menu", () => {
    assert.ok(investigationOptions.some((o) => o.id === "traffic-rush" && o.label === "Traffic rush (innocent deploy)"));
  });

  it("fires its alert: the series' last point is over the threshold, the rate three times its baseline", async () => {
    const alert = await source.queryMetric({ name: s.alert.metric, windowMinutes: 30 });
    assert.ok(alert && alert.points.length > 0);
    assert.ok(alert.points.at(-1)!.value > s.alert.threshold);
    assert.ok(alert.points.slice(0, -1).every((p) => p.value <= s.alert.threshold));
    const rate = await source.queryMetric({ name: "http.server.request.rate", windowMinutes: 45 });
    const before = rate!.points.slice(0, -5).map((p) => p.value);
    assert.ok(before.every((v) => v >= 1.4 && v <= 3.1), "a steady 2 req/s before the rush");
    assert.ok(rate!.points.at(-1)!.value > 5.5);
  });

  it("stays slow until the rate returns, then recovers", () => {
    assert.ok(s.recovery!.length > 0);
    assert.ok(s.recovery![0].value > s.alert.threshold, "nothing was changed, so the next minute is still slow");
    assert.ok(s.recovery!.some((p) => p.value < s.alert.threshold));
  });

  it("answers the deploy history with the journal deploy first and alone", async () => {
    const day = await source.deployHistory({ sinceMinutes: 1440 });
    assert.equal(day.length, 1);
    const [deploy] = day;
    assert.equal(deploy.sha, "417b767");
    assert.equal(deploy.kind, "deploy");
    assert.equal(deploy.branch, "shopfront-release/journal-copy");
    assert.equal(deploy.message, "chore(shopfront): reword the journal page intro");
    assert.ok(Date.parse(deploy.deployedAt) < Date.parse(s.now));
    const [newest] = await source.gitLog({ limit: 1 });
    assert.equal(newest.sha, "417b767");
    assert.deepEqual(newest.files, ["src/app/(store)/journal/page.tsx"]);
  });

  it("logs the restart with every flag off, the one deploy, the slow requests and no errors", async () => {
    const [flags] = await source.queryLogs({ service: "shopfront", contains: "flags: loaded", windowMinutes: 45 });
    assert.ok(flags);
    assert.match(flags.message, /"flag\.FF_LIVE_RATINGS":false/);
    assert.match(flags.message, /"flag\.FF_LIST_PRICES":false/);
    assert.match(flags.message, /"flag\.FF_STOCK_DIRECT_QUERY":false/);
    assert.equal(flags.count, 1);
    const flips = await source.queryLogs({ service: "shopfront", contains: "ops: ", windowMinutes: 45 });
    assert.equal(flips.length, 0, "no flag was flipped in the window");
    const warnings = await source.queryLogs({ service: "shopfront", minLevel: "warn", windowMinutes: 45 });
    assert.ok(warnings.every((l) => l.level === "warn"));
    assert.equal(warnings.filter((l) => l.message.startsWith("deploy: ")).length, 1);
    const slow = warnings.filter((l) => l.message.startsWith("slow request "));
    assert.ok(slow.length >= 5);
    assert.ok(slow.every((l) => Date.parse(l.firstSeen) >= Date.parse("2026-11-02T07:14:00Z")));
    const errors = await source.queryLogs({ minLevel: "error", windowMinutes: 45 });
    assert.equal(errors.length, 0);
  });

  it("serves the trap: the live-ratings loop behind a flag that is off, and the stale reviews query", async () => {
    const ratings = await source.readSource("src/lib/ratings.ts");
    assert.match(ratings!.content, /isEnabled\("FF_LIVE_RATINGS"\)/);
    assert.match(ratings!.content, /for \(const id of productIds\)/);
    const journal = await source.readSource("src/app/(store)/journal/page.tsx");
    assert.match(journal!.content, /how they are made, and the occasional visit to where they come from/);
    assert.doesNotMatch(journal!.content, /@\/db\//);
    const { rows } = await source.dbDiagnostics("slow_queries");
    assert.ok(rows.some((r) => String(r.query).includes("reviews")));
  });

  it("keeps the errors and the pool flat while every page slows with the rate", async () => {
    const errors = await source.queryMetric({ name: "http.server.error_ratio", windowMinutes: 45 });
    assert.ok(errors!.points.every((p) => p.value === 0));
    const used = await source.queryMetric({ name: "db.client.connection.count{state=used}", windowMinutes: 45 });
    assert.ok(used!.points.every((p) => p.value <= 2));
    const slowPages = (await source.queryTraces({ service: "shopfront", minDurationMs: 1400, limit: 20, windowMinutes: 45 })).filter(
      (sp) => sp.service === "shopfront",
    );
    assert.ok(slowPages.length >= 5);
    assert.ok(slowPages.every((sp) => sp.status === "ok" && !sp.route?.startsWith("/api/")));
    assert.ok(slowPages.every((sp) => Number(sp.attributes["db.client.connection.wait_time_ms"] ?? 0) < 40));
    const api = await source.queryMetric({ name: "http.server.request.duration.p95{route=/api/products}", windowMinutes: 45 });
    assert.ok(api!.points.every((p) => p.value < 200));
  });

  it("grades a healthy verdict that names the traffic as a hit, and the recorded answer as a miss", () => {
    const healthy: InvestigationReport = {
      summary: "Nothing is broken: the store is at capacity. Traffic tripled at 07:17 and every page slowed with it; the journal deploy changed one sentence.",
      hypotheses: [],
      verdict: {
        kind: "healthy",
        rationale: { text: "Latency rose with the request rate on every page, with no errors, no pool pressure and no code change in the path.", evidenceIds: ["ev_metric_1"] },
      },
      servicesQueried: ["shopfront", "postgres"],
    };
    const hit = grade(healthy, undefined, s.expected!);
    assert.equal(hit.hit, true, hit.reasons.join("; "));
    assert.deepEqual(hit.reasons, ["verdict healthy", 'mentions "traffic"', "no mitigation proposed"]);

    const leading: Hypothesis = {
      id: "h1",
      title: "Live-ratings N+1 over huge reviews table slows homepage",
      confidence: 0.62,
      status: "leading",
      causalChain: {
        symptom: { text: "GET / p95 breached threshold with 19 slow requests and 1.5-1.7s traces", evidenceIds: ["ev_metric_1"] },
        propagation: { text: "Homepage does withListingRatings twice per render, and all SSR pages slow together while APIs stay fast", evidenceIds: ["ev_source_2"] },
        rootCause: { text: "getListingRatings loops per-product over reviews with 50k rows per product, mean 1.3s per reviews query despite index", evidenceIds: ["ev_source_1"] },
      },
    };
    const recorded: InvestigationReport = {
      summary: "Home page slowed because src/lib/ratings.ts averages 50,000 reviews per product one-by-one, jamming the server as traffic grew.",
      hypotheses: [leading],
      verdict: { kind: "root_cause", hypothesisId: "h1" },
      servicesQueried: ["postgres", "shopfront"],
    };
    const flagOff: Mitigation = {
      kind: "flag_off",
      target: "FF_LIVE_RATINGS",
      title: "Turn off FF_LIVE_RATINGS",
      why: { text: "The code the diagnosis blames only runs while FF_LIVE_RATINGS is on.", evidenceIds: ["ev_source_1"] },
      steps: [],
      undo: "",
      risk: "very_low",
      state: "proposed",
      proposedAt: s.now,
    };
    const miss = grade(recorded, flagOff, s.expected!);
    assert.equal(miss.hit, false);
    assert.deepEqual(miss.reasons, ["blames src/lib/ratings.ts, expected no file", "mitigation flag_off FF_LIVE_RATINGS proposed, expected none"]);
  });
});
