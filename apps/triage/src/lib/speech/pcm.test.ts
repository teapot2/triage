import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { level, Resampler, toPcm16 } from "./pcm";

const ramp = (from: number, count: number) => Float32Array.from({ length: count }, (_, i) => from + i);

describe("Resampler", () => {
  it("passes samples through when the rates match", () => {
    assert.deepEqual([...new Resampler(24_000, 24_000).push(ramp(0, 4))], [0, 1, 2, 3]);
  });

  it("halves 48 kHz to 24 kHz", () => {
    assert.deepEqual([...new Resampler(48_000, 24_000).push(ramp(0, 8))], [0, 2, 4, 6]);
  });

  it("keeps its place across blocks of odd lengths", () => {
    const r = new Resampler(48_000, 24_000);
    const out = [...r.push(ramp(0, 3)), ...r.push(ramp(3, 4)), ...r.push(ramp(7, 5))];
    assert.deepEqual(out, [0, 2, 4, 6, 8, 10]);
  });

  it("interpolates across the seam between blocks", () => {
    // 44.1 kHz to 24 kHz: a ramp stays a ramp, whatever the block sizes.
    const r = new Resampler(44_100, 24_000);
    const out = [...r.push(ramp(0, 100)), ...r.push(ramp(100, 37)), ...r.push(ramp(137, 200))];
    const step = 44_100 / 24_000;
    out.forEach((v, i) => assert.ok(Math.abs(v - i * step) < 1e-3, `sample ${i}: ${v} vs ${i * step}`));
    assert.equal(out.length, Math.floor(336 / step) + 1);
  });

  it("returns nothing for an empty block", () => {
    assert.equal(new Resampler(48_000, 24_000).push(new Float32Array()).length, 0);
  });
});

describe("toPcm16", () => {
  it("writes little-endian 16-bit samples, clipped to the range", () => {
    const view = new DataView(toPcm16(Float32Array.from([0, 1, -1, 2, -2, 0.5])));
    assert.deepEqual(
      Array.from({ length: 6 }, (_, i) => view.getInt16(i * 2, true)),
      [0, 32767, -32768, 32767, -32768, 16384],
    );
  });
});

describe("level", () => {
  it("is 0 for silence and for nothing", () => {
    assert.equal(level(new Float32Array(128)), 0);
    assert.equal(level(new Float32Array()), 0);
  });

  it("caps at 1 for a loud block", () => {
    assert.equal(level(new Float32Array(128).fill(0.9)), 1);
  });
});
