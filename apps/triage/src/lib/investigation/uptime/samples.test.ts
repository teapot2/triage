import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { closeDb, getDb, transaction } from "../../db";
import type { UptimeSample } from "./model";
import {
  appendSample,
  deleteSamples,
  MAX_SAMPLES,
  pruneSamples,
  readHourly,
  readSamples,
  readSamplesSince,
} from "./samples";

// samples.ts on a temp working directory, so .data/triage.db is ours. Each
// test has its own check ids; pruning is database-wide, so the prune tests
// each sit in their own stretch of time.
const cwd = process.cwd();
let dir: string;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "triage-samples-"));
  process.chdir(dir);
});
after(async () => {
  closeDb();
  process.chdir(cwd);
  await rm(dir, { recursive: true, force: true });
});

const at = (iso: string, plusMs = 0) => new Date(Date.parse(iso) + plusMs).toISOString();
const ok = (iso: string, ms = 100): UptimeSample => ({ at: iso, ms, status: 200, outcome: "ok" });

// Straight into the table: hundreds of appends would each read the window.
function insert(checkId: string, samples: UptimeSample[]) {
  const db = getDb();
  const stmt = db.prepare("INSERT INTO uptime_samples (check_id, at, ms, status, outcome, error) VALUES (?, ?, ?, ?, ?, ?)");
  transaction(db, () => {
    for (const s of samples) stmt.run(checkId, Date.parse(s.at), s.ms, s.status ?? null, s.outcome, s.error ?? null);
  });
}

const exists = (file: string) => access(file).then(() => true, () => false);

describe("uptime samples in SQLite", () => {
  it("round-trips a sample with and without its optional fields", async () => {
    const samples: UptimeSample[] = [
      ok("2026-10-30T12:00:00.000Z"),
      { at: "2026-10-30T12:00:30.000Z", ms: 15_000, outcome: "down", error: "timeout after 15000 ms" },
      { at: "2026-10-30T12:01:00.000Z", ms: 240, status: 503, outcome: "down", error: "status 503" },
      { at: "2026-10-30T12:01:30.000Z", ms: 2400, status: 200, outcome: "slow" },
    ];
    for (const s of samples) await appendSample("chk_round1", s);
    const read = await readSamples("chk_round1");
    assert.deepEqual(read, samples);
    assert.equal("status" in read[1], false);
    assert.equal("error" in read[0], false);
  });

  it("drops a second result for one check in the same millisecond", async () => {
    await appendSample("chk_dupe01", ok("2026-10-30T12:00:00.000Z", 100));
    const after = await appendSample("chk_dupe01", ok("2026-10-30T12:00:00.000Z", 999));
    assert.deepEqual(after, [ok("2026-10-30T12:00:00.000Z", 100)]);
  });

  it("answers with the last 500, oldest first", async () => {
    const samples = Array.from({ length: MAX_SAMPLES + 100 }, (_, i) => ok(at("2026-10-30T00:00:00.000Z", i * 10_000), i));
    insert("chk_window", samples.slice(0, -1));
    const appended = await appendSample("chk_window", samples.at(-1)!);
    assert.equal(appended.length, MAX_SAMPLES);
    assert.deepEqual(appended, samples.slice(-MAX_SAMPLES));
    assert.deepEqual(await readSamples("chk_window"), appended);
  });

  it("reads every result since a time, oldest first", async () => {
    const samples = Array.from({ length: 10 }, (_, i) => ok(at("2026-10-30T06:00:00.000Z", i * 60_000)));
    insert("chk_since1", samples);
    assert.deepEqual(await readSamplesSince("chk_since1", samples[6].at), samples.slice(6));
    assert.deepEqual(await readSamplesSince("chk_since1", "2026-10-31T00:00:00.000Z"), []);
  });

  it("summarises complete hours only, never the current one", async () => {
    insert("chk_hours1", [
      ok("2026-09-10T10:00:00.000Z", 100),
      { at: "2026-09-10T10:20:00.000Z", ms: 3000, status: 200, outcome: "slow" },
      { at: "2026-09-10T10:59:59.999Z", ms: 15_000, outcome: "down", error: "timeout" },
      ok("2026-09-10T11:00:00.000Z", 50),
      ok("2026-09-10T11:20:00.000Z", 70),
    ]);
    await pruneSamples(Date.parse("2026-09-10T11:30:00.000Z"));
    const hourly = await readHourly("chk_hours1", "2026-09-10T00:00:00.000Z", "2026-09-11T00:00:00.000Z");
    assert.deepEqual(hourly, [
      { hour: "2026-09-10T10:00:00.000Z", checks: 3, ok: 1, slow: 1, down: 1, avgMs: 6033.333333333333, maxMs: 15_000 },
    ]);
    // Nothing in raw is old enough to go yet.
    assert.equal((await readSamplesSince("chk_hours1", "2026-09-10T00:00:00.000Z")).length, 5);

    // A result that lands after its hour closed is counted next time.
    insert("chk_hours1", [ok("2026-09-10T10:40:00.000Z", 200)]);
    await pruneSamples(Date.parse("2026-09-10T12:00:00.000Z"));
    const again = await readHourly("chk_hours1", "2026-09-10T00:00:00.000Z", "2026-09-11T00:00:00.000Z");
    assert.deepEqual(
      again.map((h) => [h.hour, h.checks, h.ok]),
      [
        ["2026-09-10T10:00:00.000Z", 4, 2],
        ["2026-09-10T11:00:00.000Z", 2, 2],
      ],
    );
    // from is inclusive, to exclusive.
    assert.equal((await readHourly("chk_hours1", "2026-09-10T11:00:00.000Z", "2026-09-10T12:00:00.000Z")).length, 1);
    assert.equal((await readHourly("chk_hours1", "2026-09-10T10:00:00.001Z", "2026-09-10T11:00:00.000Z")).length, 0);
  });

  it("deletes raw past 48 hours by whole hours, after summarising them", async () => {
    insert("chk_aging1", [ok("2026-08-01T10:15:00.000Z", 100), ok("2026-08-01T10:45:00.000Z", 300)]);
    // 48 hours later falls inside that hour: the hour stays whole in raw.
    await pruneSamples(Date.parse("2026-08-03T10:30:00.000Z"));
    assert.equal((await readSamplesSince("chk_aging1", "2026-08-01T00:00:00.000Z")).length, 2);
    // Once the whole hour is past 48 hours it goes, and its summary stays.
    await pruneSamples(Date.parse("2026-08-03T11:00:00.000Z"));
    assert.deepEqual(await readSamplesSince("chk_aging1", "2026-08-01T00:00:00.000Z"), []);
    assert.deepEqual(await readHourly("chk_aging1", "2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z"), [
      { hour: "2026-08-01T10:00:00.000Z", checks: 2, ok: 2, slow: 0, down: 0, avgMs: 200, maxMs: 300 },
    ]);

    // Raw first seen after it's already past 48 hours is summarised in the
    // same prune that deletes it.
    insert("chk_aging2", [ok("2026-08-01T09:30:00.000Z")]);
    await pruneSamples(Date.parse("2026-08-03T11:00:00.000Z"));
    assert.deepEqual(await readSamplesSince("chk_aging2", "2026-08-01T00:00:00.000Z"), []);
    assert.equal((await readHourly("chk_aging2", "2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z"))[0]?.checks, 1);
  });

  it("deletes hourly summaries past 90 days", async () => {
    insert("chk_old001", [ok("2026-03-01T10:00:00.000Z"), ok("2026-03-02T10:00:00.000Z")]);
    await pruneSamples(Date.parse("2026-03-03T12:00:00.000Z"));
    assert.equal((await readHourly("chk_old001", "2026-03-01T00:00:00.000Z", "2026-03-03T00:00:00.000Z")).length, 2);
    // 90 days after 2026-03-01T10:00 is 2026-05-30T10:00.
    await pruneSamples(Date.parse("2026-05-30T10:30:00.000Z"));
    assert.deepEqual(
      (await readHourly("chk_old001", "2026-03-01T00:00:00.000Z", "2026-03-03T00:00:00.000Z")).map((h) => h.hour),
      ["2026-03-02T10:00:00.000Z"],
    );
  });

  it("deletes a check's raw results and hourly history", async () => {
    insert("chk_gone01", [ok("2026-07-01T10:00:00.000Z"), ok("2026-07-01T11:00:00.000Z")]);
    insert("chk_kept01", [ok("2026-07-01T10:00:00.000Z")]);
    await pruneSamples(Date.parse("2026-07-01T11:30:00.000Z"));
    await deleteSamples("chk_gone01");
    assert.deepEqual(await readSamples("chk_gone01"), []);
    assert.deepEqual(await readHourly("chk_gone01", "2026-07-01T00:00:00.000Z", "2026-07-02T00:00:00.000Z"), []);
    assert.equal((await readSamples("chk_kept01")).length, 1);
    assert.equal((await readHourly("chk_kept01", "2026-07-01T00:00:00.000Z", "2026-07-02T00:00:00.000Z")).length, 1);
  });

  it("moves the old JSON files in on open, leaving any it can't read", async (t) => {
    const errors = t.mock.method(console, "error", () => {});
    const uptimeDir = path.join(dir, ".data", "uptime");
    await mkdir(uptimeDir, { recursive: true });
    const legacy = [ok("2026-10-29T08:00:00.000Z"), { at: "2026-10-29T08:00:30.000Z", ms: 15_000, outcome: "down", error: "timeout" }] satisfies UptimeSample[];
    const good = path.join(uptimeDir, "chk_legacy.json");
    const broken = path.join(uptimeDir, "chk_broken.json");
    const invalid = path.join(uptimeDir, "chk_invali.json");
    await writeFile(good, JSON.stringify({ samples: legacy }));
    await writeFile(broken, "{ not json");
    await writeFile(invalid, JSON.stringify({ samples: [{ at: "yesterday" }] }));

    closeDb();
    assert.deepEqual(await readSamples("chk_legacy"), legacy);
    assert.equal(await exists(good), false);
    assert.equal(await exists(broken), true);
    assert.equal(await exists(invalid), true);
    assert.equal(errors.mock.callCount(), 2);

    // A crash after the commit but before the delete imports it again.
    await writeFile(good, JSON.stringify({ samples: [...legacy, ok("2026-10-29T08:01:00.000Z")] }));
    closeDb();
    assert.deepEqual(await readSamples("chk_legacy"), [...legacy, ok("2026-10-29T08:01:00.000Z")]);
    assert.equal(await exists(good), false);
  });

  it("refuses ids that aren't check ids", async () => {
    await assert.rejects(readSamples("../uptime-checks"), /not an uptime check id/);
    await assert.rejects(appendSample("chk_x/../../y", ok("2026-10-30T12:00:00.000Z")), /not an uptime check id/);
    await assert.rejects(readSamplesSince("chk_", "2026-10-30T12:00:00.000Z"), /not an uptime check id/);
    await assert.rejects(readHourly("CHK_AAAAAA", "2026-10-30T00:00:00.000Z", "2026-10-31T00:00:00.000Z"), /not an uptime check id/);
    await assert.rejects(deleteSamples("chk_aaaaaa'; DROP TABLE uptime_samples; --"), /not an uptime check id/);
  });
});
