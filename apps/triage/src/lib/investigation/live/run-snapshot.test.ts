import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { DbCheck, DbResult, TelemetrySource } from "../source";
import { listSourceFiles } from "./live-source";
import { hasSnapshotFiles, takeRunSnapshot, withSnapshot } from "./run-snapshot";

// The snapshot is written under the working directory's .data, so the test
// runs in a scratch one.
let cwd: string;
let scratch: string;
before(async () => {
  cwd = process.cwd();
  scratch = await mkdtemp(path.join(os.tmpdir(), "triage-snapshot-"));
  process.chdir(scratch);
});
after(async () => {
  process.chdir(cwd);
  await rm(scratch, { recursive: true, force: true });
});

const db = (check: DbCheck, value: string): DbResult => ({ query: `SELECT ${check}`, rows: [{ value }] });

// A source whose database and files say "now", to tell them from the
// snapshot's.
const present: TelemetrySource = {
  describe: () => ({ id: "live:shopfront", now: "2026-11-02T10:00:00.000Z", services: [], metrics: [] }),
  queryLogs: async () => [],
  queryTraces: async () => [],
  queryMetric: async () => undefined,
  dbDiagnostics: async (check) => db(check, "now"),
  readSource: async (p) => ({ path: p, content: "now" }),
  listSourceFiles: async () => ["src/now.ts"],
  gitLog: async () => [],
  deployHistory: async () => [],
};

describe("run snapshot", () => {
  it("answers database and source reads as they were when the run started", async () => {
    const id = "inc_snapshot_test";
    const snapshot = await takeRunSnapshot(id, { dbDiagnostics: async (check) => db(check, "then") });
    assert.ok(snapshot, "the snapshot is saved");
    assert.ok(await hasSnapshotFiles(id));

    const source = await withSnapshot(present, id, snapshot);
    assert.deepEqual(await source.dbDiagnostics("activity"), db("activity", "then"));
    // The files the live source could read then, Shopfront's source tree.
    const files = await source.listSourceFiles();
    assert.deepEqual(files, await listSourceFiles());
    const file = files.find((f) => f.startsWith("src/"))!;
    assert.ok((await source.readSource(file))?.content.length);
    assert.equal((await source.readSource(`apps/shopfront/${file}`))?.path, file);
    assert.equal(await source.readSource("src/now.ts"), undefined);
    assert.equal(await source.readSource("../../.env"), undefined);
    // Telemetry still comes from the source, anchored at the alert.
    assert.equal(source.describe().now, "2026-11-02T10:00:00.000Z");
  });

  it("says when there is none", async () => {
    assert.equal(await hasSnapshotFiles("inc_never_taken"), false);
  });
});
