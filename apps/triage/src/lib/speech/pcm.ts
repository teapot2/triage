// Microphone samples as Meta's transcription wants them: the browser records
// float samples at its own rate (often 48 kHz), Meta takes 16-bit
// little-endian PCM at 24 kHz. Pure, so it is tested without a browser.

// Meta's native rate for realtime transcription (PCM_24KHZ).
export const TRANSCRIBE_SAMPLE_RATE = 24_000;

// Converts a stream of float blocks from one rate to another by linear
// interpolation, keeping its place across blocks so the seams don't click.
// Plenty for speech: the voice band sits well under either Nyquist.
export class Resampler {
  private readonly step: number;
  // Where the next output sample falls, in input samples from the start of
  // the next block (negative: between the last block's final sample and the
  // next block's first).
  private position = 0;
  private last = 0;

  constructor(from: number, to: number) {
    this.step = from / to;
  }

  push(input: Float32Array): Float32Array {
    if (this.step === 1) return input.slice();
    const out: number[] = [];
    let p = this.position;
    // A point past the block's last sample waits for the next block.
    while (p <= input.length - 1) {
      const i = Math.floor(p);
      const t = p - i;
      const a = i < 0 ? this.last : input[i];
      const b = i + 1 < input.length ? input[i + 1] : a;
      out.push(a + (b - a) * t);
      p += this.step;
    }
    this.position = p - input.length;
    if (input.length > 0) this.last = input[input.length - 1];
    return Float32Array.from(out);
  }
}

// Floats in [-1, 1] as 16-bit little-endian signed integers, clipped.
export function toPcm16(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  return buffer;
}

// How loud a block is, 0 to 1, for the listening meter: its RMS, scaled so
// ordinary speech (RMS around 0.05 to 0.2) fills most of the range.
export function level(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.min(1, Math.sqrt(sum / samples.length) * 5);
}
