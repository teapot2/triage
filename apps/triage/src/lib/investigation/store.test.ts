import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { closeDb, getDb } from "../db";
import { exampleIncidents } from "./fixtures";
import { archiveBlocker } from "./archive";
import { SUMMARY_VERSION, toSummary } from "./list-summary";
import { resolved } from "./postmortem/test-incidents";
import type { Incident } from "./schema";
import { incidentHeadline } from "./summary";

// The incident store on SQLite, each test on a fresh working directory so
// .data (and the database in it) is its own.
const cwd = process.cwd();
let dir: string;
let store: typeof import("./store");

before(async () => {
  store = await import("./store");
});
beforeEach(async () => {
  closeDb();
  process.chdir(cwd);
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  dir = await mkdtemp(path.join(tmpdir(), "triage-store-"));
  process.chdir(dir);
});
after(async () => {
  closeDb();
  process.chdir(cwd);
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

const incident = (id: string, patch: Partial<Incident> = {}): Incident => ({ ...resolved(), id, ...patch });
const runIds = (list: { id: string }[]) => list.map((i) => i.id).filter((id) => !store.isExample(id));

describe("incident store", () => {
  it("saves, reads, lists newest first and deletes", async () => {
    await store.saveIncident(incident("inc_old", { detectedAt: "2026-11-01T10:00:00.000Z", run: undefined }));
    await store.saveIncident(incident("inc_new", { detectedAt: "2026-11-02T10:00:00.000Z", run: undefined }));
    assert.equal((await store.getIncident("inc_new"))?.id, "inc_new");
    assert.deepEqual(runIds(await store.listIncidents()), ["inc_new", "inc_old"]);
    // The examples follow the runs, in their own order.
    assert.deepEqual(
      (await store.listIncidents()).slice(2).map((i) => i.id),
      exampleIncidents.map((e) => e.id),
    );

    await store.removeIncident("inc_old");
    assert.equal(await store.getIncident("inc_old"), undefined);
    assert.deepEqual(runIds(await store.listIncidents()), ["inc_new"]);
  });

  it("filters archived incidents in the query", async () => {
    await store.saveIncident(incident("inc_active"));
    await store.saveIncident(incident("inc_gone", { archivedAt: "2026-11-02T12:00:00.000Z" }));
    assert.deepEqual(runIds(await store.listIncidents()), ["inc_active"]);
    assert.deepEqual(runIds(await store.listIncidents({ archived: "only" })), ["inc_gone"]);
    assert.equal(runIds(await store.listIncidents({ archived: "include" })).length, 2);
    // No example is archived, so none is listed with the archived ones.
    assert.equal((await store.listIncidents({ archived: "only" })).length, 1);
  });

  it("puts a saved example in the bundled one's place", async () => {
    const example = exampleIncidents[1];
    await store.patchIncident(example.id, (i) => ({ ...i, title: "Changed" }));
    const listed = await store.listIncidents();
    assert.equal(listed.find((i) => i.id === example.id)?.title, "Changed");
    assert.equal(listed.filter((i) => i.id === example.id).length, 1);
    assert.equal(listed.length, exampleIncidents.length);
  });

  it("runs patches one after another, none lost", async () => {
    await store.saveIncident(incident("inc_count", { title: "0" }));
    await Promise.all(
      Array.from({ length: 20 }, () => store.patchIncident("inc_count", (i) => ({ ...i, title: String(Number(i.title) + 1) }))),
    );
    assert.equal((await store.getIncident("inc_count"))?.title, "20");
    const row = getDb().prepare("SELECT version FROM incidents WHERE id = ?").get("inc_count") as { version: number };
    assert.equal(row.version, 21);
  });

  it("leaves the incident as it was when a patch throws", async () => {
    await store.saveIncident(incident("inc_throw", { title: "Before" }));
    await assert.rejects(
      store.patchIncident("inc_throw", () => {
        throw new Error("nope");
      }),
    );
    assert.equal((await store.getIncident("inc_throw"))?.title, "Before");
    await assert.rejects(store.patchIncident("inc_missing", (i) => i), /unknown incident/);
  });

  it("saves nothing when a patch returns the incident unchanged", async () => {
    await store.saveIncident(incident("inc_same"));
    await store.patchIncident("inc_same", (i) => i);
    const row = getDb().prepare("SELECT version FROM incidents WHERE id = ?").get("inc_same") as { version: number };
    assert.equal(row.version, 1);
    // Nor is a bundled example saved by one.
    await store.patchIncident(exampleIncidents[0].id, (i) => i);
    assert.equal(getDb().prepare("SELECT 1 FROM incidents WHERE id = ?").get(exampleIncidents[0].id), undefined);
  });

  it("lists one service's incidents, or one rule's, examples included", async () => {
    const rule = { id: "rule_api", name: "API latency", description: "p95 over 500 ms" };
    await store.saveIncident(incident("inc_rule", { service: "shopfront", trigger: { ...resolved().trigger, rule } }));
    await store.saveIncident(incident("inc_other", { service: "payments" }));
    const all = await store.listIncidents();
    for (const list of [store.listIncidents, store.listIncidentSummaries]) {
      assert.deepEqual(
        (await list({ service: "payments" })).map((i) => i.id),
        all.filter((i) => i.service === "payments").map((i) => i.id),
      );
      assert.deepEqual(
        (await list({ ruleId: "rule_api" })).map((i) => i.id),
        all.filter((i) => i.trigger.rule?.id === "rule_api").map((i) => i.id),
      );
    }
    assert.ok((await store.listIncidentSummaries({ ruleId: "rule_api" })).some((i) => i.id === "inc_rule"));
    // A bundled example carries a rule too, and is listed under it.
    const exampleRule = exampleIncidents.find((e) => e.trigger.rule)?.trigger.rule;
    if (exampleRule) {
      const ids = (await store.listIncidentSummaries({ ruleId: exampleRule.id })).map((i) => i.id);
      assert.ok(ids.some((id) => store.isExample(id)));
    }
  });

  it("summarises what the lists show without the arrays", async () => {
    const whole = incident("inc_sum_fields");
    await store.saveIncident(whole);
    const summary = (await store.listIncidentSummaries()).find((s) => s.id === "inc_sum_fields")!;
    assert.deepEqual(summary, JSON.parse(JSON.stringify(toSummary(whole))));
    assert.equal(summary.headline, incidentHeadline(whole));
    assert.equal(summary.archiveBlocker, archiveBlocker(whole));
    for (const key of ["steps", "evidence", "thoughts", "questions", "reruns"]) assert.equal(key in summary, false, key);
  });

  it("lists summaries without the body, remaking stale ones", async () => {
    await store.saveIncident(incident("inc_sum", { title: "Pool leak" }));
    const [summary] = await store.listIncidentSummaries();
    assert.equal(summary.id, "inc_sum");
    assert.equal(summary.title, "Pool leak");
    assert.equal("steps" in summary, false);

    getDb().prepare("UPDATE incidents SET summary = '{}', summary_version = 0 WHERE id = ?").run("inc_sum");
    assert.equal((await store.listIncidentSummaries())[0].title, "Pool leak");
    const row = getDb().prepare("SELECT summary_version FROM incidents WHERE id = ?").get("inc_sum") as {
      summary_version: number;
    };
    assert.equal(row.summary_version, SUMMARY_VERSION);
  });

  it("imports the old incident files, then deletes them", async () => {
    const files = path.join(dir, ".data", "incidents");
    await mkdir(files, { recursive: true });
    await writeFile(path.join(files, "inc_file_a.json"), JSON.stringify(incident("inc_file_a")));
    await writeFile(path.join(files, "inc_file_b.json"), JSON.stringify(incident("inc_file_b")));
    await writeFile(path.join(files, "inc_broken.json"), "{ not json");

    assert.deepEqual(runIds(await store.listIncidents()).sort(), ["inc_file_a", "inc_file_b"]);
    // The broken file stays for someone to look at; the others are gone.
    assert.deepEqual(await readdir(files), ["inc_broken.json"]);

    // A second open finds nothing new to import.
    closeDb();
    assert.equal(runIds(await store.listIncidents()).length, 2);
    assert.deepEqual(await readdir(files), ["inc_broken.json"]);
  });

  it("keeps a row over an older file for the same incident", async () => {
    await store.saveIncident(incident("inc_both", { title: "From the database" }));
    closeDb();
    const files = path.join(dir, ".data", "incidents");
    await mkdir(files, { recursive: true });
    await writeFile(path.join(files, "inc_both.json"), JSON.stringify(incident("inc_both", { title: "From a file" })));
    assert.equal((await store.getIncident("inc_both"))?.title, "From the database");
    await assert.rejects(readdir(files), { code: "ENOENT" });
  });
});
