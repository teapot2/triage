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

describe("grade, no defect", () => {
  const rush: Expected = {
    verdict: "no_defect",
    rootCauseFiles: [],
    mustMention: [["traffic", "load", "rush", "request rate", "requests per second"]],
    mitigation: "none",
  };
  const rollback = (): Mitigation => ({ ...flagOff("0dfdbac", "rollback"), title: "Roll back shopfront to the deploy before 0dfdbac" });

  it("hits a healthy verdict whose rationale names the load, with nothing proposed", () => {
    const r: InvestigationReport = {
      hypotheses: [],
      verdict: { kind: "healthy", rationale: claim("Latency tracks the request rate: traffic tripled and nothing failed") },
      servicesQueried: ["shopfront"],
    };
    const g = grade(r, undefined, rush);
    assert.equal(g.hit, true, g.reasons.join("; "));
    assert.ok(g.reasons.includes("verdict healthy"));
    assert.ok(g.reasons.includes("no mitigation proposed"));
  });

  it("hits a root cause that blames the traffic without a mitigation", () => {
    const g = grade(report("A traffic rush saturated the server; the journal copy deploy is unrelated"), undefined, rush);
    assert.equal(g.hit, true, g.reasons.join("; "));
    assert.ok(g.reasons.includes("verdict root_cause"));
  });

  it("hits an inconclusive verdict that names the load among what is missing", () => {
    const r: InvestigationReport = {
      hypotheses: [],
      verdict: { kind: "inconclusive", missing: ["capacity figures for the request rate seen in the window"] },
      servicesQueried: ["shopfront"],
    };
    assert.equal(grade(r, undefined, rush).hit, true);
  });

  it("misses when a rollback is proposed, whatever the words say", () => {
    const g = grade(report("The traffic rush after deploy 0dfdbac slowed the API"), rollback(), rush);
    assert.equal(g.hit, false);
    assert.deepEqual(g.reasons, ["mitigation rollback 0dfdbac proposed, expected none"]);
  });

  it("misses a root cause that pins the load on a source file, named or cited", () => {
    const named = grade(report("Traffic tripled and src/lib/ratings.ts averages every review per product"), undefined, rush);
    assert.equal(named.hit, false);
    assert.deepEqual(named.reasons, ["blames src/lib/ratings.ts, expected no file"]);
    const source: Evidence = {
      id: "ev_source_1",
      kind: "source",
      tool: "read_source",
      summary: "getListingRatings",
      file: "src/lib/ratings.ts",
      startLine: 1,
      code: "export async function getListingRatings() {}",
    };
    const cited = grade(report("Traffic tripled and the ratings loop jammed the server", { ids: ["ev_source_1"] }), undefined, rush, [source]);
    assert.equal(cited.hit, false);
    assert.deepEqual(cited.reasons, ["blames src/lib/ratings.ts, expected no file"]);
  });

  it("hits when a file is cited or named only to show what slowed, not as the cause", () => {
    const journal: Evidence = {
      id: "ev_source_1",
      kind: "source",
      tool: "read_source",
      summary: "JournalPage",
      file: "src/app/(store)/journal/page.tsx",
      startLine: 1,
      code: "export default function JournalPage() {}",
    };
    const r = report("Doubled traffic saturated the single Node process and queued every render", {
      summary: "Pages slowed as visitor numbers doubled; nothing is broken",
    });
    r.hypotheses[0].causalChain.propagation = claim(
      "Even src/app/(store)/journal/page.tsx, which reads no database, slowed to 2 s: the delay is in the shared process, not a route's query",
      ["ev_source_1"],
    );
    const g = grade(r, undefined, rush, [journal]);
    assert.equal(g.hit, true, g.reasons.join("; "));
    assert.ok(g.reasons.includes("verdict root_cause"));
  });

  it("misses when the words never mention the load", () => {
    const g = grade(report("Deploy 0dfdbac made the product list slow"), undefined, rush);
    assert.equal(g.hit, false);
    assert.equal(g.reasons.length, 1);
    assert.match(g.reasons[0], /mentions none of/);
  });
});

describe("grade on a dependency scenario", () => {
  const vulnerable: Expected = {
    verdict: "root_cause",
    rootCauseFiles: ["src/lib/runtime.ts"],
    mustMention: [["semver"]],
    mitigation: "none",
    exposure: "reachable",
  };
  const runtime: Evidence = {
    id: "ev_source_1",
    tool: "grep_source",
    kind: "source",
    summary: "src/lib/runtime.ts:1",
    file: "src/lib/runtime.ts",
    startLine: 1,
    code: 'import semver from "semver";',
  };
  const exposed = (verdict?: NonNullable<InvestigationReport["exposure"]>["verdict"]): InvestigationReport => ({
    ...report("semver 7.5.1 is inside the advisory's vulnerable range", { ids: ["ev_source_1"] }),
    ...(verdict && { exposure: { verdict, rationale: claim("src/lib/runtime.ts imports semver for the health check", ["ev_source_1"]) } }),
  });

  it("hits on the expected exposure, citing the importing file", () => {
    const g = grade(exposed("reachable"), undefined, vulnerable, [runtime]);
    assert.equal(g.hit, true, g.reasons.join("; "));
    assert.ok(g.reasons.includes("exposure reachable"));
  });

  it("misses on another exposure, or none", () => {
    assert.deepEqual(grade(exposed("transitive_only"), undefined, vulnerable, [runtime]).reasons, [
      "exposure transitive_only, expected reachable",
    ]);
    assert.deepEqual(grade(exposed(), undefined, vulnerable, [runtime]).reasons, ["exposure missing, expected reachable"]);
  });
});
