import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exampleIncidents } from "../../lib/investigation/fixtures";
import type { Incident, MetricPoint } from "../../lib/investigation/schema";
import { chartSeries } from "./chart-series";

const minute = (hhmm: string) => `2026-10-31T${hhmm}:00.000Z`;
const points = (from: string, values: number[]): MetricPoint[] =>
  values.map((value, i) => ({ t: new Date(Date.parse(minute(from)) + i * 60_000).toISOString(), value }));

// The price list gap run of Oct 30 (inc_mvvpdgbb_aba8be): the alert's series
// ends at the minute it fired (01:08), the recovery watch's starts at the
// first minute wholly after the flag went off at 01:10:23 (01:11), and the
// verification's overlaps the recovery's last minute.
function priceGapRun(): Incident {
  const example = structuredClone(exampleIncidents[0]);
  const metric = "http.server.error_ratio{route=/api/products/[id]}";
  return {
    ...example,
    detectedAt: "2026-10-31T01:08:52.047Z",
    status: "resolved",
    resolvedAt: minute("01:16"),
    trigger: { ...example.trigger, metric, unit: "ratio", threshold: 0.05, observed: 0.2, series: points("01:04", [0, 0, 0, 0, 0.2]) },
    mitigation: {
      kind: "flag_off",
      target: "FF_LIST_PRICES",
      title: "Turn off FF_LIST_PRICES",
      why: { text: "The symptom began after FF_LIST_PRICES was turned on.", evidenceIds: [] },
      steps: ["Turn off FF_LIST_PRICES on shopfront"],
      undo: "Turn FF_LIST_PRICES back on",
      risk: "very_low",
      state: "applied",
      proposedAt: "2026-10-31T01:09:22.276Z",
      decidedAt: "2026-10-31T01:10:23.023Z",
      appliedAt: "2026-10-31T01:10:23.075Z",
      recovery: {
        metric,
        threshold: 0.05,
        since: "2026-10-31T01:10:23.075Z",
        series: points("01:11", [0, 0]),
        status: "recovered",
        recoveredAt: minute("01:11"),
      },
    },
    verification: {
      after: "mitigation",
      since: minute("01:11"),
      windowMinutes: 5,
      metric,
      threshold: 0.05,
      series: points("01:12", [0, 0, 0, 0, 0]),
      status: "resolved",
      startedAt: "2026-10-31T01:13:08.329Z",
      finishedAt: "2026-10-31T01:17:08.656Z",
    },
  } as Incident;
}

describe("chartSeries", () => {
  it("keeps the minutes between the alert and the recovery, as empty points", () => {
    const series = chartSeries(priceGapRun(), []);
    assert.deepEqual(
      series.map((p) => [p.t.slice(11, 16), p.value]),
      [
        ["01:04", 0],
        ["01:05", 0],
        ["01:06", 0],
        ["01:07", 0],
        ["01:08", 0.2],
        // Nobody recorded these: not the alert, which ends where it fired,
        // nor the recovery watch, which starts after the mitigation.
        ["01:09", null],
        ["01:10", null],
        ["01:11", 0],
        ["01:12", 0],
        ["01:13", 0],
        ["01:14", 0],
        ["01:15", 0],
        ["01:16", 0],
      ],
    );
  });

  it("has one point a minute, so markers land on their own minute", () => {
    const times = chartSeries(priceGapRun(), []).map((p) => Date.parse(p.t));
    assert.ok(times.slice(1).every((t, i) => t - times[i] === 60_000));
  });

  it("still stretches to a marker shortly after the last point", () => {
    const series = chartSeries(priceGapRun(), [{ t: "2026-10-31T01:19:30.000Z", label: "reopened" }]);
    assert.deepEqual(
      series.slice(-4).map((p) => [p.t.slice(11, 16), p.value]),
      [
        ["01:17", null],
        ["01:18", null],
        ["01:19", null],
        ["01:20", null],
      ],
    );
  });

  it("doesn't add an empty twin for a point off the minute", () => {
    const incident = priceGapRun();
    incident.trigger.series = [...incident.trigger.series.slice(0, -1), { t: "2026-10-31T01:08:20.000Z", value: 0.2 }];
    const series = chartSeries(incident, []);
    assert.deepEqual(
      series.slice(3, 8).map((p) => [p.t.slice(11, 19), p.value]),
      [
        ["01:07:00", 0],
        ["01:08:20", 0.2],
        ["01:09:20", null],
        ["01:10:20", null],
        ["01:11:00", 0],
      ],
    );
  });
});
