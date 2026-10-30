import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { exampleIncidents } from "./fixtures";
import type { Incident } from "./schema";
import { sourceFor } from "./source-for";
import { sourceKind } from "./source-kind";
import { saveChecks } from "./uptime/checks";
import { defaultCheck } from "./uptime/model";
import { appendSample } from "./uptime/samples";

// The uptime case reads .data from the working directory: a temp one.
const cwd = process.cwd();
let dir: string;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "triage-source-for-"));
  process.chdir(dir);
});
after(async () => {
  process.chdir(cwd);
  await rm(dir, { recursive: true, force: true });
});

const withSource = (source: string | undefined): Incident => ({
  ...structuredClone(exampleIncidents[0]),
  detectedAt: "2026-10-28T10:00:00.000Z",
  run: source === undefined ? undefined : { source, model: "muse-spark-1.3", startedAt: "2026-10-28T10:00:00.000Z" },
});

describe("sourceFor", () => {
  it("rebuilds a scenario from its ID, at the scenario's own time", async () => {
    const source = await sourceFor(withSource("scenario:pool-leak"));
    assert.equal(source?.describe().id, "scenario:pool-leak");
    assert.equal(sourceKind(withSource("scenario:healthy")), "scenario");
  });

  it("anchors the live source at the alert, not at the call", async () => {
    assert.equal(sourceKind(withSource("live:shopfront")), "live");
    const source = await sourceFor(withSource("live:shopfront"));
    assert.equal(source?.describe().id, "live:shopfront");
    assert.equal(source?.describe().now, "2026-10-28T10:00:00.000Z");
  });

  it("rebuilds an uptime check's source from its saved samples, at the alert", async () => {
    const check = defaultCheck({ id: "chk_abc123", name: "Google", url: "https://www.google.com/" });
    await saveChecks([check]);
    await appendSample(check.id, { at: "2026-10-28T09:59:30.000Z", ms: 15_000, outcome: "down", error: "timeout after 15000 ms" });
    await appendSample(check.id, { at: "2026-10-28T10:00:30.000Z", ms: 180, status: 200, outcome: "ok" });
    const incident = withSource("uptime:chk_abc123");
    assert.equal(sourceKind(incident), "uptime");
    const source = await sourceFor(incident);
    assert.equal(source?.describe().id, "uptime:chk_abc123");
    assert.equal(source?.describe().now, "2026-10-28T10:00:00.000Z");
    assert.deepEqual(source?.describe().services, [{ name: "www.google.com", dependsOn: [] }]);
    const logs = await source!.queryLogs({ windowMinutes: 30 });
    assert.deepEqual(logs.map((g) => [g.message, g.count]), [["timeout after 15000 ms", 1]]);

    // A deleted check still answers, from the URL the incident recorded.
    const gone = withSource("uptime:chk_zzz999");
    gone.trigger.route = "https://example.com/";
    assert.deepEqual((await sourceFor(gone))?.describe().services, [{ name: "example.com", dependsOn: [] }]);
    assert.equal(sourceKind(withSource("uptime:../etc")), undefined);
  });

  it("has none for the bundled examples, unknown scenarios and other sources", async () => {
    for (const incident of exampleIncidents) assert.equal(await sourceFor(incident), undefined);
    assert.equal(await sourceFor(withSource("scenario:nope")), undefined);
    assert.equal(sourceKind(withSource("scenario:nope")), undefined);
    assert.equal(await sourceFor(withSource("otlp:elsewhere")), undefined);
    assert.equal(await sourceFor(withSource(undefined)), undefined);
  });
});
