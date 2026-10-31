import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LanguageModelUsage } from "ai";
import { costOf, priceFor } from "../models/pricing";
import { addUsage, noTokens } from "../models/usage";
import { cachedShare, formatCost, incidentUsage } from "./cost";
import { exampleIncidents } from "./fixtures";
import type { Incident } from "./schema";

const usage = (input: number, cached: number, output: number, reasoning: number) =>
  ({
    inputTokens: input,
    inputTokenDetails: { noCacheTokens: input - cached, cacheReadTokens: cached, cacheWriteTokens: undefined },
    outputTokens: output,
    outputTokenDetails: { textTokens: output - reasoning, reasoningTokens: reasoning },
    totalTokens: input + output,
  }) as LanguageModelUsage;

describe("addUsage", () => {
  it("sums cached input and reasoning across calls, as Meta reports them", () => {
    const total = noTokens();
    addUsage(total, usage(10_000, 0, 500, 300));
    addUsage(total, usage(12_000, 9_600, 400, 250));
    assert.deepEqual(total, { inputTokens: 22_000, cachedInputTokens: 9_600, outputTokens: 900, reasoningTokens: 550 });
  });
});

describe("costOf", () => {
  it("bills cached input at Meta's cached rate", () => {
    // 400K uncached at $1.25, 600K cached at $0.15, 10K out at $4.25.
    const cost = costOf({ inputTokens: 1_000_000, cachedInputTokens: 600_000, outputTokens: 10_000 }, "meta", "muse-spark-1.3");
    assert.equal(cost?.toFixed(5), (0.5 + 0.09 + 0.0425).toFixed(5));
  });

  it("knows each Meta model, and has no price for hosted open weights", () => {
    assert.equal(priceFor("meta", "muse-wonder-1.0")?.input, 4);
    assert.equal(priceFor("meta", "muse-spark-1.1")?.cachedInput, 0.15);
    assert.equal(priceFor("meta", "muse-spark-1.2-contributor")?.output, 0.2);
    assert.equal(priceFor("ollama", "muse-glimmer-30b")?.input, 0);
    assert.equal(priceFor("openrouter", "meta/muse-spark-1.3"), undefined);
    assert.equal(costOf({ inputTokens: 100 }, "fireworks", "muse-glimmer-30b"), undefined);
  });
});

describe("incidentUsage", () => {
  const base = exampleIncidents[0];
  const incident: Incident = {
    ...base,
    run: { ...base.run!, provider: "meta", model: "muse-spark-1.3", inputTokens: 100_000, cachedInputTokens: 60_000, outputTokens: 2_000, reasoningTokens: 1_500 },
    questions: [],
    postmortem: undefined,
    fixAttempts: [],
    fixRun: undefined,
  };

  it("adds up every stage, with the cached share", () => {
    const u = incidentUsage(incident)!;
    assert.deepEqual(Object.keys(u.stages), ["investigate"]);
    assert.equal(cachedShare(u.tokens), 0.6);
    assert.equal(u.tokens.reasoningTokens, 1_500);
    assert.equal(formatCost(u.cost!), "$0.07");
  });

  it("leaves the cost out when a stage ran on a model with no price", () => {
    const u = incidentUsage({
      ...incident,
      fixRun: { status: "proven", attempt: 1, startedAt: base.detectedAt, provider: "openrouter", model: "meta/muse-spark-1.3", inputTokens: 5_000, outputTokens: 100 },
    })!;
    assert.equal(u.cost, undefined);
    assert.equal(u.stages.investigate?.cost?.toFixed(4), "0.0675");
    assert.equal(u.tokens.inputTokens, 105_000);
  });

  it("is undefined when nothing recorded tokens", () => {
    assert.equal(incidentUsage({ ...incident, run: { ...incident.run!, inputTokens: undefined, outputTokens: undefined } }), undefined);
  });
});
