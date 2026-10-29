import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exampleIncidents } from "./fixtures";
import type { Incident } from "./schema";
import { sourceFor } from "./source-for";
import { sourceKind } from "./source-kind";

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

  it("has none for the bundled examples, unknown scenarios and other sources", async () => {
    for (const incident of exampleIncidents) assert.equal(await sourceFor(incident), undefined);
    assert.equal(await sourceFor(withSource("scenario:nope")), undefined);
    assert.equal(sourceKind(withSource("scenario:nope")), undefined);
    assert.equal(await sourceFor(withSource("otlp:elsewhere")), undefined);
    assert.equal(await sourceFor(withSource(undefined)), undefined);
  });
});
