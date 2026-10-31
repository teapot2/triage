import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chartSeries } from "../../../components/incident/chart-series";
import { exampleIncidents } from "../../investigation/fixtures";
import type { ChartPoint } from "../../investigation/schema";
import { serialize } from "../serialize";
import { chartRows, chartSeriesDataset } from "./chart";

const meta = { subject: { kind: "incident", id: "inc_pool_leak", name: "Pool leak" }, exportedAt: new Date("2026-10-30T02:15:30.000Z") };
const p95 = { metric: "p95 latency", unit: "ms" };

describe("chartRows", () => {
  it("leaves out the gaps the chart draws as a break", () => {
    const series: ChartPoint[] = [
      { t: "2026-10-31T01:07:00.000Z", value: 0.2 },
      { t: "2026-10-31T01:08:00.000Z", value: null },
      { t: "2026-10-31T01:09:00.000Z", value: 0 },
    ];
    const rows = chartRows(series, p95);
    assert.deepEqual(
      rows.map((r) => [r.time, r.value]),
      [
        ["2026-10-31T01:07:00.000Z", 0.2],
        // A real zero is a point, drawn and kept.
        ["2026-10-31T01:09:00.000Z", 0],
      ],
    );
  });

  it("keeps only the recorded minutes of an incident's chart, not the empty ones it adds", () => {
    const incident = structuredClone(exampleIncidents[0]);
    const recorded = incident.trigger.series;
    // A marker 10 minutes on stretches the chart with empty minutes.
    const end = Date.parse(recorded[recorded.length - 1].t);
    const drawn = chartSeries(incident, [{ t: new Date(end + 10 * 60_000).toISOString(), label: "Mitigated" }]);
    assert.ok(drawn.some((p) => p.value === null));
    const rows = chartRows(drawn, p95);
    assert.equal(rows.length, drawn.filter((p) => p.value !== null).length);
    assert.ok(rows.every((r) => typeof r.value === "number"));
  });

  it("carries the threshold into limit on every row, and none without one", () => {
    const series: ChartPoint[] = [
      { t: "2026-10-31T01:07:00.000Z", value: 410 },
      { t: "2026-10-31T01:08:00.000Z", value: 1290 },
    ];
    assert.deepEqual(
      chartRows(series, { ...p95, limit: 800 }).map((r) => r.limit),
      [800, 800],
    );
    assert.deepEqual(
      chartRows(series, p95).map((r) => r.limit),
      [undefined, undefined],
    );
  });

  it("writes times as ISO, whatever their spelling", () => {
    const rows = chartRows([{ t: "2026-10-31T01:07:00Z", value: 1 }, { t: "2026-10-31T03:08:00+02:00", value: 2 }], p95);
    assert.deepEqual(
      rows.map((r) => r.time),
      ["2026-10-31T01:07:00.000Z", "2026-10-31T01:08:00.000Z"],
    );
  });

  it("keeps values as drawn, unrounded", () => {
    const [row] = chartRows([{ t: "2026-10-31T01:07:00.000Z", value: 812.3456789 }], p95);
    assert.equal(row.value, 812.3456789);
  });
});

describe("chart-series files", () => {
  const rows = chartRows(
    [
      { t: "2026-10-31T01:07:00.000Z", value: 410.5 },
      { t: "2026-10-31T01:08:00.000Z", value: null },
      { t: "2026-10-31T01:09:00.000Z", value: 1290 },
    ],
    { ...p95, limit: 800 },
  );

  it("CSV: the five columns, the gap left out", () => {
    const { body } = serialize(chartSeriesDataset, rows, "csv", meta);
    assert.equal(
      body,
      "﻿time,value,unit,metric,limit\r\n" +
        "2026-10-31T01:07:00.000Z,410.5,ms,p95 latency,800\r\n" +
        "2026-10-31T01:09:00.000Z,1290,ms,p95 latency,800\r\n",
    );
  });

  it("CSV: no limit is an empty cell", () => {
    const { body } = serialize(chartSeriesDataset, chartRows([{ t: "2026-10-31T01:07:00.000Z", value: 3 }], p95), "csv", meta);
    assert.match(body, /\r\n2026-10-31T01:07:00\.000Z,3,ms,p95 latency,\r\n$/);
  });

  it("JSON: no limit is null, so every row has every key", () => {
    const { body } = serialize(chartSeriesDataset, chartRows([{ t: "2026-10-31T01:07:00.000Z", value: 3 }], p95), "json", meta);
    const file = JSON.parse(body);
    assert.equal(file.dataset, "chart-series");
    assert.equal(file.count, 1);
    assert.deepEqual(file.rows, [{ time: "2026-10-31T01:07:00.000Z", value: 3, unit: "ms", metric: "p95 latency", limit: null }]);
  });
});
