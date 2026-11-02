import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Evidence, Hypothesis, InvestigationReport, Mitigation } from "../schema";
import { grade } from "./grade";
import type { Expected } from "./scenario-source";

const priceGap: Expected = {
  verdict: "root_cause",
  rootCauseFiles: ["src/lib/prices.ts"],
  mustMention: [["product_prices"], ["stock", "join"], ["missing", "no row"]],
  mitigation: { kind: "flag_off", target: "FF_LIST_PRICES" },
};
const healthy: Expected = { verdict: "no_root_cause", rootCauseFiles: [], mustMention: [] };

const claim = (text: string, evidenceIds = ["ev_log_1"]) => ({ text, evidenceIds });

function report(rootCause: string, opts: { title?: string; summary?: string; ids?: string[] } = {}): InvestigationReport {
  const leading: Hypothesis = {
    id: "h1",
    title: opts.title ?? "Product API 500s",
    confidence: 0.8,
    status: "leading",
    causalChain: {
      symptom: claim("GET /api/products/[id] answers 500 for some products"),
      propagation: claim("The handler throws a TypeError reading amountCents"),
      rootCause: claim(rootCause, opts.ids),
    },
  };
  const other: Hypothesis = { ...leading, id: "h2", title: "Database slow", status: "rejected", confidence: 0.1 };
  return {
    summary: opts.summary,
    hypotheses: [leading, other],
    verdict: { kind: "root_cause", hypothesisId: "h1" },
    servicesQueried: ["shopfront"],
  };
}

const flagOff = (target = "FF_LIST_PRICES", kind: Mitigation["kind"] = "flag_off"): Mitigation => ({
  kind,
  target,
  title: `Turn off ${target}`,
  why: claim("turned on just before"),
  steps: [],
  undo: "",
  risk: "very_low",
  state: "proposed",
  proposedAt: "2026-10-30T23:20:00.000Z",
});

const right =
  "getListPrice in src/lib/prices.ts destructures the product_prices row, which is missing for products without a stock row: syncListPrices inner-joins stock_levels.";

describe("grade", () => {
  it("hits a diagnosis that makes every point, with the right mitigation", () => {
    const g = grade(report(right), flagOff(), priceGap);
    assert.equal(g.hit, true);
    assert.ok(g.reasons.includes("names src/lib/prices.ts"));
    assert.ok(g.reasons.includes("mitigation flag_off FF_LIST_PRICES"));
  });

  it("matches words case-insensitively, across the summary, title and chain", () => {
    const g = grade(
      report("getListPrice crashes on an absent row", {
        title: "PRICES.TS reads PRODUCT_PRICES",
        summary: "Products with no row in the price list (synced through a JOIN on stock) fail.",
      }),
      flagOff(),
      priceGap,
    );
    assert.equal(g.hit, true, g.reasons.join("; "));
  });

  it("counts a cited source file when the text doesn't name it", () => {
    const source: Evidence = {
      id: "ev_source_1",
      kind: "source",
      tool: "read_source",
      summary: "getListPrice",
      file: "src/lib/prices.ts",
      startLine: 25,
      code: "const [{ amountCents }] = await db.select()",
    };
    const text = "getListPrice destructures a missing product_prices row; the sync joins stock_levels";
    assert.equal(grade(report(text), flagOff(), priceGap).hit, false);
    assert.equal(grade(report(text, { ids: ["ev_source_1"] }), flagOff(), priceGap, [source]).hit, true);
  });

  it("misses each point it doesn't make, one reason per point", () => {
    const g = grade(report("A bad deploy of src/lib/prices.ts"), flagOff(), priceGap);
    assert.equal(g.hit, false);
    assert.equal(g.reasons.length, 3);
    assert.ok(g.reasons.every((r) => r.startsWith("mentions none of")));
  });

  it("misses the wrong file", () => {
    const g = grade(report(right.replace("src/lib/prices.ts", "src/lib/stock.ts")), flagOff(), priceGap);
    assert.equal(g.hit, false);
    assert.deepEqual(g.reasons, ["doesn't name or cite src/lib/prices.ts"]);
  });

  it("misses a missing or different mitigation", () => {
    assert.deepEqual(grade(report(right), undefined, priceGap).reasons, ["no mitigation proposed, expected flag_off FF_LIST_PRICES"]);
    assert.deepEqual(grade(report(right), flagOff("96eb094", "rollback"), priceGap).reasons, [
      "mitigation rollback 96eb094, expected flag_off FF_LIST_PRICES",
    ]);
    assert.equal(grade(report(right), flagOff("FF_STOCK_DIRECT_QUERY"), priceGap).hit, false);
  });

  it("grades a rollback expectation on the sha", () => {
    const formattedPrice: Expected = {
      verdict: "root_cause",
      rootCauseFiles: ["src/lib/money.ts"],
      mustMention: [["currency"]],
      mitigation: { kind: "rollback", target: "9f3c2a1" },
    };
    const text = "formatPrice in src/lib/money.ts calls Intl.NumberFormat with style currency and no currency code";
    const hit = grade(report(text), flagOff("9f3c2a1", "rollback"), formattedPrice);
    assert.equal(hit.hit, true, hit.reasons.join("; "));
    assert.ok(hit.reasons.includes("mitigation rollback 9f3c2a1"));
    assert.deepEqual(grade(report(text), flagOff("FF_LIST_PRICES"), formattedPrice).reasons, [
      "mitigation flag_off FF_LIST_PRICES, expected rollback 9f3c2a1",
    ]);
  });

  it("ignores the mitigation when none is expected", () => {
    assert.equal(grade(report(right), undefined, { ...priceGap, mitigation: undefined }).hit, true);
  });

  it("only reads the leading hypothesis", () => {
    const r = report("The database is slow");
    r.hypotheses[1] = { ...r.hypotheses[1], causalChain: { ...r.hypotheses[1].causalChain, rootCause: claim(right) } };
    assert.equal(grade(r, flagOff(), priceGap).hit, false);
  });

  it("misses a verdict other than root_cause when a cause is expected", () => {
    const r: InvestigationReport = { ...report(right), verdict: { kind: "inconclusive", missing: ["logs"] } };
    assert.deepEqual(grade(r, undefined, priceGap), { hit: false, reasons: ["expected root_cause, got inconclusive"] });
  });

  it("scores no root cause: healthy and inconclusive hit, root_cause misses", () => {
    const healthyReport: InvestigationReport = {
      hypotheses: [],
      verdict: { kind: "healthy", rationale: claim("All at baseline") },
      servicesQueried: ["shopfront"],
    };
    assert.deepEqual(grade(healthyReport, undefined, healthy), { hit: true, reasons: ["verdict healthy"] });
    assert.equal(grade({ ...healthyReport, verdict: { kind: "inconclusive", missing: [] } }, undefined, healthy).hit, true);
    assert.deepEqual(grade(report(right), flagOff(), healthy), {
      hit: false,
      reasons: ["expected no root cause, got root_cause (h1)"],
    });
  });
});
