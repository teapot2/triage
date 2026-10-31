import type { ChartPoint, Incident } from "@/lib/investigation/schema";
import type { ChartMarker } from "./metric-chart";

const MINUTE = 60_000;

// How far past the last point a marker may stretch the chart: a reopening
// by hand comes after the verification's last minute. Further than this the
// chart's scale would say nothing, and the notice says it instead.
const STRETCH_MS = 30 * MINUTE;

// The alert's metric as far as it was watched: the alert's series, the
// recovery watch's, then the verification's, one point per time. The x axis
// is the points' own timestamps, so a minute nobody recorded (between the
// alert's last minute and the first one wholly after the mitigation) is an
// empty point, a break in the line, rather than missing from the axis. Empty
// minutes also stretch it to a marker shortly after its last point.
export function chartSeries(incident: Incident, markers: ChartMarker[]): ChartPoint[] {
  const byTime = new Map<string, ChartPoint>();
  for (const p of [
    ...incident.trigger.series,
    ...(incident.mitigation?.recovery?.series ?? []),
    ...(incident.verification?.series ?? []),
  ]) {
    if (!byTime.has(p.t)) byTime.set(p.t, p);
  }
  const points: ChartPoint[] = [...byTime.values()].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  if (points.length < 2) return points;

  // The series' own resolution: the closest two points are one step apart.
  const times = points.map((p) => Date.parse(p.t));
  const step = Math.min(...times.slice(1).map((t, i) => t - times[i]).filter((d) => d > 0)) || MINUTE;
  const empty = (t: number): ChartPoint => ({ t: new Date(t).toISOString(), value: null });

  const series: ChartPoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    // Half a step of slack, so a point off the minute doesn't get an empty twin.
    for (let t = times[i - 1] + step; t <= times[i] - step / 2; t += step) series.push(empty(t));
    series.push(points[i]);
  }

  const end = times[times.length - 1];
  const reach = Math.max(
    end,
    ...markers.map((m) => Date.parse(m.t)).filter((t) => t > end && t - end <= STRETCH_MS),
  );
  for (let t = end + step; t - step < reach; t += step) series.push(empty(t));
  return series;
}
