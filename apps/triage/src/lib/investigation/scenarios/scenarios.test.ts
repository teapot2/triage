import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { investigationOptions } from "../options";
import { QuestionRecorder } from "../recorder";
import type { Question } from "../schema";
import type { DbCheck } from "../source";
import { createInvestigationTools } from "../tools";
import { getScenario, scenarios } from ".";
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
});
