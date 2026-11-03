import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { z } from "zod";
import { closeDb, getDb, transaction } from "./db";
import { InvalidLegacyFile, storedDocument } from "./documents";

// documents.ts on a temp working directory, so .data is ours.
const cwd = process.cwd();
let dir: string;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "triage-documents-"));
  process.chdir(dir);
  await mkdir(path.join(dir, ".data"), { recursive: true });
});
after(async () => {
  closeDb();
  process.chdir(cwd);
  await rm(dir, { recursive: true, force: true });
});

const schema = z.object({ n: z.number(), tags: z.array(z.string()).default([]) });
const legacy = (name: string) => path.join(dir, ".data", name);
const row = (name: string) => getDb().prepare("SELECT body FROM documents WHERE name = ?").get(name) as { body: string } | undefined;

// Each test starts on a fresh handle, as a restart would, so the old file is
// looked for again.
beforeEach(() => closeDb());

describe("stored documents", () => {
  it("reads undefined when nothing is saved, then round-trips", () => {
    const doc = storedDocument("round-trip", "round-trip.json", (v) => schema.parse(v));
    assert.equal(doc.read(), undefined);
    doc.write({ n: 1, tags: ["a"] });
    assert.deepEqual(doc.read(), { n: 1, tags: ["a"] });
    assert.deepEqual(JSON.parse(row("round-trip")!.body), { n: 1, tags: ["a"] });
  });

  it("refuses to write a value parse refuses", () => {
    const doc = storedDocument("refused", "refused.json", (v) => schema.parse(v));
    assert.throws(() => doc.write({ n: "one" } as never));
    assert.equal(row("refused"), undefined);
  });

  it("changes in one transaction", () => {
    const doc = storedDocument("counter", "counter.json", (v) => schema.parse(v));
    for (let i = 0; i < 3; i++) doc.change((c) => ({ n: (c?.n ?? 0) + 1, tags: [] }));
    assert.equal(doc.read()?.n, 3);
    assert.throws(() =>
      doc.change(() => {
        throw new Error("no");
      }),
    );
    assert.equal(doc.read()?.n, 3);
  });

  it("imports the old file on the first read, then deletes it", async () => {
    await writeFile(legacy("imported.json"), JSON.stringify({ n: 7 }));
    const doc = storedDocument("imported", "imported.json", (v) => schema.parse(v));
    assert.deepEqual(doc.read(), { n: 7, tags: [] });
    assert.equal(existsSync(legacy("imported.json")), false);
    assert.deepEqual(JSON.parse(row("imported")!.body), { n: 7, tags: [] });
  });

  it("imports the old file before a write, which then replaces it", async () => {
    await writeFile(legacy("written.json"), JSON.stringify({ n: 1 }));
    const doc = storedDocument("written", "written.json", (v) => schema.parse(v));
    doc.write({ n: 2, tags: [] });
    assert.equal(existsSync(legacy("written.json")), false);
    assert.equal(doc.read()?.n, 2);
  });

  it("keeps a row already saved over the old file, and deletes the file", async () => {
    const doc = storedDocument("newer", "newer.json", (v) => schema.parse(v));
    doc.write({ n: 2, tags: [] });
    closeDb();
    await writeFile(legacy("newer.json"), JSON.stringify({ n: 1 }));
    assert.equal(doc.read()?.n, 2);
    assert.equal(existsSync(legacy("newer.json")), false);
  });

  it("leaves the old file until a read outside a transaction", async () => {
    await writeFile(legacy("deferred.json"), JSON.stringify({ n: 4 }));
    const doc = storedDocument("deferred", "deferred.json", (v) => schema.parse(v));
    const d = getDb();
    assert.throws(() =>
      transaction(d, () => {
        assert.equal(doc.read()?.n, 4);
        assert.equal(existsSync(legacy("deferred.json")), true);
        throw new Error("rolled back");
      }),
    );
    // The import rolled back with it; the file is still there to import.
    assert.equal(row("deferred"), undefined);
    assert.equal(doc.read()?.n, 4);
    assert.equal(existsSync(legacy("deferred.json")), false);
  });

  it("throws on an old file that doesn't parse, naming it, and leaves it in place", async () => {
    await writeFile(legacy("broken.json"), "{ not json");
    const doc = storedDocument("broken", "broken.json", (v) => schema.parse(v));
    assert.throws(
      () => doc.read(),
      (err: unknown) => err instanceof InvalidLegacyFile && err.file === legacy("broken.json") && /broken\.json isn't valid \(/.test(err.message),
    );
    // A write would drop what the file holds, so it throws too.
    assert.throws(() => doc.write({ n: 1, tags: [] }), InvalidLegacyFile);
    assert.equal(existsSync(legacy("broken.json")), true);
    assert.equal(row("broken"), undefined);

    await writeFile(legacy("broken.json"), JSON.stringify({ n: "one" }));
    assert.throws(() => doc.read(), (err: unknown) => err instanceof InvalidLegacyFile && /n/.test(err.why));

    // Fixed, it imports on the next read.
    await writeFile(legacy("broken.json"), JSON.stringify({ n: 5 }));
    assert.equal(doc.read()?.n, 5);
    assert.equal(existsSync(legacy("broken.json")), false);
  });
});
