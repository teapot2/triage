import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fitWithin, ladder, MAX_SIDE } from "./shrink";

describe("fitWithin", () => {
  it("scales the long side down to the limit, keeping the shape", () => {
    assert.deepEqual(fitWithin(3200, 1800, 1600), { width: 1600, height: 900 });
    assert.deepEqual(fitWithin(1000, 4000, 1600), { width: 400, height: 1600 });
  });

  it("never scales up, or below one pixel", () => {
    assert.deepEqual(fitWithin(800, 600, 1600), { width: 800, height: 600 });
    assert.deepEqual(fitWithin(10_000, 1, 1600), { width: 1600, height: 1 });
  });
});

describe("ladder", () => {
  it("starts at the full size and only gets smaller or lossier", () => {
    assert.deepEqual(ladder[0], { side: MAX_SIDE, quality: 0.85 });
    for (let i = 1; i < ladder.length; i++) {
      const [prev, step] = [ladder[i - 1], ladder[i]];
      assert.ok(step.side <= prev.side && step.quality <= prev.quality && (step.side < prev.side || step.quality < prev.quality));
    }
  });
});
