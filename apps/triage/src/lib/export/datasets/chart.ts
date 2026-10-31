import type { ChartPoint } from "@/lib/investigation/schema";
import { defineDataset } from "../dataset";

// A chart's line as a file: the points MetricChart draws, with what they
// measure on every row so a file passed around on its own still says it.

export type ChartRow = { time: string; value: number; unit: string; metric: string; limit?: number };

export const chartSeriesDataset = defineDataset<ChartRow>({
  id: "chart-series",
  name: "Chart data",
  columns: [
    { key: "time", value: (r) => r.time },
    { key: "value", value: (r) => r.value },
    { key: "unit", value: (r) => r.unit },
    { key: "metric", value: (r) => r.metric },
    { key: "limit", value: (r) => r.limit },
  ],
  formats: ["csv", "json"],
});

// The rows for one chart. A null point is a break in the line, nothing drawn,
// so it's left out rather than written as an empty or zero value: a blank
// cell reads as 0 to some spreadsheets, and the jump in time already shows
// the gap. Values are as drawn, unrounded.
export function chartRows(
  series: readonly ChartPoint[],
  { metric, unit, limit }: { metric: string; unit: string; limit?: number },
): ChartRow[] {
  return series.flatMap((p) => (p.value === null ? [] : [{ time: isoTime(p.t), value: p.value, unit, metric, limit }]));
}

// Points come from stored records and live buckets; whatever the source's
// spelling, the file has one. A time that doesn't parse is kept as it was.
function isoTime(t: string): string {
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? t : new Date(ms).toISOString();
}
