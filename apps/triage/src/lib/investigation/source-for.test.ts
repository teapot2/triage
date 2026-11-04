import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { closeDb } from "../db";
import { exampleIncidents } from "./fixtures";
import { toSummary } from "./list-summary";
import type { Incident } from "./schema";
import { ASK_REACH_MINUTES, askSourceFor, sourceFor } from "./source-for";
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
  // Windows won't delete the temp directory while the database is open.
  closeDb();
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
    // A list summary carries the source too, for the list's replay tag.
    assert.equal(sourceKind(toSummary(withSource("scenario:healthy"))), "scenario");
    assert.equal(sourceKind(toSummary(withSource(undefined))), undefined);
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

// Ask's tools: past the alert where there is later telemetry to read.
describe("askSourceFor", () => {
  const alert = Date.parse("2026-10-28T10:00:00.000Z");
  const minutes = (n: number) => alert + n * 60_000;

  it("reads a live run up to now, at most ASK_REACH_MINUTES past the alert", async () => {
    const live = withSource("live:shopfront");
    const soon = await askSourceFor(live, minutes(25.5));
    assert.equal(soon?.source.describe().now, new Date(minutes(25.5)).toISOString());
    assert.equal(soon?.pastAlert, 25);
    const later = await askSourceFor(live, minutes(600));
    assert.equal(later?.source.describe().now, new Date(minutes(ASK_REACH_MINUTES)).toISOString());
    assert.equal(later?.pastAlert, ASK_REACH_MINUTES);
    // Within the first minute, it is the alert's source.
    const atAlert = await askSourceFor(live, minutes(0.5));
    assert.equal(atAlert?.source.describe().now, "2026-10-28T10:00:00.000Z");
    assert.equal(atAlert?.pastAlert, 0);
  });

  it("reads an endpoint check's samples after the alert", async () => {
    const check = defaultCheck({ id: "chk_def456", name: "Example", url: "https://example.org/" });
    await saveChecks([check]);
    await appendSample(check.id, { at: "2026-10-28T09:59:30.000Z", ms: 15_000, outcome: "down", error: "timeout after 15000 ms" });
    await appendSample(check.id, { at: "2026-10-28T10:20:30.000Z", ms: 15_000, outcome: "down", error: "connection reset" });
    const incident = withSource("uptime:chk_def456");
    const at = await sourceFor(incident);
    assert.deepEqual((await at!.queryLogs({ windowMinutes: 30 })).map((g) => g.message), ["timeout after 15000 ms"]);
    const asked = await askSourceFor(incident, minutes(30));
    assert.equal(asked?.pastAlert, 30);
    assert.deepEqual(
      (await asked!.source.queryLogs({ windowMinutes: 60 })).map((g) => g.message).sort(),
      ["connection reset", "timeout after 15000 ms"],
    );
  });

  it("keeps a recorded scenario, and anything without later data, at its recording", async () => {
    const scenario = withSource("scenario:pool-leak");
    const asked = await askSourceFor(scenario, minutes(60));
    assert.equal(asked?.pastAlert, 0);
    assert.equal(asked?.source.describe().now, (await sourceFor(scenario))?.describe().now);
    for (const incident of exampleIncidents) assert.equal(await askSourceFor(incident, minutes(60)), undefined);
  });
});
