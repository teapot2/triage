import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isOpenWeights, isSparkOpen, providers } from "./providers";

describe("isSparkOpen", () => {
  it("matches every provider's Spark Open model, and nothing else", () => {
    const sparkOpen = Object.values(providers).flatMap((p) => (p.sparkOpen ? [p.sparkOpen] : []));
    assert.ok(sparkOpen.length > 0);
    for (const model of sparkOpen) assert.equal(isSparkOpen(model), true, model);
    for (const model of ["muse-spark-1.3", "muse-wonder-1.0", "meta/muse-glimmer-30b", "muse-glimmer:30b"]) {
      assert.equal(isSparkOpen(model), false, model);
    }
  });

  it("is one kind of open weights", () => {
    assert.equal(isOpenWeights("meta/muse-spark-open"), true);
    assert.equal(isOpenWeights("meta/muse-glimmer-30b"), true);
    assert.equal(isSparkOpen("meta/muse-glimmer-30b"), false);
  });
});
