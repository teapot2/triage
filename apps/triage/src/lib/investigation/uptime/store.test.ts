import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { defaultCheck, readChecks, saveChecks } from "./checks";
import type { UptimeSample } from "./model";
import { appendSample, deleteSamples, MAX_SAMPLES, readSamples } from "./samples";

// checks.ts and samples.ts on a temp working directory, so .data is ours.
const cwd = process.cwd();
let dir: string;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "triage-uptime-"));
  process.chdir(dir);
});
after(async () => {
  process.chdir(cwd);
  await rm(dir, { recursive: true, force: true });
});

const sample = (i: number): UptimeSample => ({
  at: new Date(Date.parse("2026-10-30T12:00:00.000Z") + i * 30_000).toISOString(),
  ms: 100 + i,
  status: 200,
  outcome: "ok",
});

describe("uptime checks store", () => {
  it("reads no checks when nothing is saved", async () => {
    assert.deepEqual(await readChecks(), []);
  });

  it("round-trips the list", async () => {
    const checks = [
      defaultCheck({ id: "chk_aaaaaa", name: "Google", url: "https://www.google.com" }),
      defaultCheck({ id: "chk_bbbbbb", name: "Shopfront", url: "http://localhost:3001/api/health", slowMs: 2000 }),
    ];
    await saveChecks(checks);
    assert.deepEqual(await readChecks(), checks);
    const raw = JSON.parse(await readFile(path.join(dir, ".data", "uptime-checks.json"), "utf8"));
    assert.deepEqual(Object.keys(raw), ["checks"]);
  });

  it("refuses to save a list the model refuses", async () => {
    await assert.rejects(saveChecks([defaultCheck()]));
  });

  it("throws on a file that doesn't parse, naming it and why", async () => {
    await writeFile(path.join(dir, ".data", "uptime-checks.json"), "{ not json");
    await assert.rejects(readChecks(), (err: Error) => err.message.includes("uptime-checks.json") && /isn't valid \(/.test(err.message));
    await writeFile(path.join(dir, ".data", "uptime-checks.json"), JSON.stringify({ checks: [{ id: "nope" }] }));
    await assert.rejects(readChecks(), /uptime-checks\.json isn't valid/);
  });
});

describe("uptime samples store", () => {
  it("reads none for a check never run", async () => {
    assert.deepEqual(await readSamples("chk_cccccc"), []);
  });

  it("appends in order and round-trips", async () => {
    await appendSample("chk_dddddd", sample(0));
    const after = await appendSample("chk_dddddd", sample(1));
    assert.deepEqual(after, [sample(0), sample(1)]);
    assert.deepEqual(await readSamples("chk_dddddd"), [sample(0), sample(1)]);
  });

  it("keeps both of two appends at once", async () => {
    await Promise.all([appendSample("chk_eeeeee", sample(0)), appendSample("chk_eeeeee", sample(1))]);
    assert.deepEqual(await readSamples("chk_eeeeee"), [sample(0), sample(1)]);
  });

  it("keeps only the last 500", async () => {
    const file = path.join(dir, ".data", "uptime", "chk_ffffff.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ samples: Array.from({ length: MAX_SAMPLES }, (_, i) => sample(i)) }));
    const samples = await appendSample("chk_ffffff", sample(MAX_SAMPLES));
    assert.equal(samples.length, MAX_SAMPLES);
    assert.deepEqual(samples[0], sample(1));
    assert.deepEqual(samples.at(-1), sample(MAX_SAMPLES));
  });

  it("refuses ids that aren't check ids", async () => {
    await assert.rejects(readSamples("../uptime-checks"), /not an uptime check id/);
    await assert.rejects(appendSample("chk_x/../../y", sample(0)), /not an uptime check id/);
  });

  it("deletes a check's samples", async () => {
    await appendSample("chk_gggggg", sample(0));
    await deleteSamples("chk_gggggg");
    assert.deepEqual(await readSamples("chk_gggggg"), []);
  });
});
