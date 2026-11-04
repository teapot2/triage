"use client";

import { useId, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ReferenceArea, ReferenceLine, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { ExportMenu } from "@/components/export-menu";
import type { ExportSubject } from "@/lib/export/dataset";
import { chartRows, chartSeriesDataset } from "@/lib/export/datasets/chart";
import type { ChartPoint } from "@/lib/investigation/schema";
import { cn } from "@/lib/utils";
import { formatTime } from "./format";

const ordered = (a: string, b: string): [string, string] => (Date.parse(a) <= Date.parse(b) ? [a, b] : [b, a]);

export interface TimeRange {
  from: string;
  to: string;
}

export interface ChartMarker {
  t: string;
  label: string;
  // The line's color: neutral for what was done (a deploy, a mitigation),
  // success for a resolution, warning for a reopening. Labels stay neutral,
  // since green or amber text on white fails contrast.
  tone?: "default" | "success" | "warning";
}

const markerStroke: Record<NonNullable<ChartMarker["tone"]>, string> = {
  default: "var(--muted-foreground)",
  success: "var(--success)",
  warning: "var(--warning)",
};

// The series point closest to a time, since the x axis is the points' own
// timestamps. Undefined when the time falls outside the series.
function nearestPoint(series: ChartPoint[], t: string): string | undefined {
  const at = Date.parse(t);
  if (series.length === 0 || at < Date.parse(series[0].t) || at > Date.parse(series[series.length - 1].t)) return;
  return series.reduce((best, p) =>
    Math.abs(Date.parse(p.t) - at) < Math.abs(Date.parse(best.t) - at) ? p : best,
  ).t;
}

export function MetricChart({
  series,
  label,
  unit,
  threshold,
  limitLabel,
  lowerIsWorse = false,
  markers = [],
  compact = false,
  onHover,
  selection,
  onSelect,
  exportAs,
  className,
}: {
  series: ChartPoint[];
  label: string;
  unit: string;
  threshold?: number;
  // The limit line's label, "limit <threshold>" unless given ("more than 3").
  limitLabel?: string;
  // Past the limit is under it, as for availability.
  lowerIsWorse?: boolean;
  // Events to mark on the time axis, such as the deploy behind the incident.
  markers?: ChartMarker[];
  // Sparkline: no axes, grid, labels or tooltip; pair it with onHover to show
  // the hovered value somewhere that doesn't cover the line.
  compact?: boolean;
  onHover?: (point: ChartPoint | undefined) => void;
  // A time range to shade, as two of the series' own timestamps.
  selection?: TimeRange;
  // Makes the chart selectable: drag across it to pick a range; a click
  // without a drag clears it (undefined).
  onSelect?: (range: TimeRange | undefined) => void;
  // Offers the points drawn as CSV or JSON, named for this subject, from an
  // icon in the top-right corner.
  exportAs?: { subject: ExportSubject };
  className?: string;
}) {
  // The range being dragged out, from where the drag started to the point
  // under the pointer now.
  const [drag, setDrag] = useState<{ a: string; b: string }>();
  // The timestamp under the pointer. No active index (null, as before the
  // tooltip first shows) is no point, not the first one.
  const at = (state: { activeTooltipIndex?: unknown }) =>
    state.activeTooltipIndex == null ? undefined : series[Number(state.activeTooltipIndex)]?.t;
  const finish = () => {
    if (!drag) return;
    const [from, to] = ordered(drag.a, drag.b);
    onSelect?.(from === to ? undefined : { from, to });
    setDrag(undefined);
  };
  const shaded = drag ? ordered(drag.a, drag.b) : selection && [selection.from, selection.to];

  const id = useId().replace(/:/g, "");
  const fillId = `fill-${id}`;
  const strokeId = `stroke-${id}`;
  const config = {
    value: {
      label: `${label} (${unit})`,
      color: "var(--chart-1)",
    },
  } satisfies ChartConfig;

  // Red only where the line is past the limit, so the color says "breached"
  // and nothing else. Gradients span their shape's bounding box: the line's
  // runs from the series' lowest value to its highest, the area's from the
  // highest down to the 0 baseline. Each split is where the limit falls in
  // that box, from the top: 0 when nothing is past it (or there's no limit),
  // 1 when everything is. Two stops at the same offset make a hard edge.
  const values = series.flatMap((p) => (p.value === null ? [] : [p.value]));
  const max = Math.max(...values);
  const min = Math.min(...values);
  const split = (low: number) => {
    if (threshold === undefined || threshold >= max) return 0;
    if (max <= low) return 1;
    return Math.min(1, Math.max(0, (max - threshold) / (max - low)));
  };
  // Under the limit, where less is worse: red from just below it down. The
  // margin keeps a line sitting on the limit (100 % available) unred.
  const under = () => {
    if (threshold === undefined || threshold <= min) return 1;
    if (max <= min) return 0;
    return Math.min(1, (max - threshold) / (max - min) + 0.02);
  };
  const strokeSplit = lowerIsWorse ? under() : split(min);
  // The area under a line that dropped isn't what breached, so it stays plain.
  const fillSplit = lowerIsWorse ? 0 : split(0);
  const [above, below] = lowerIsWorse ? ["var(--color-value)", "var(--destructive)"] : ["var(--destructive)", "var(--color-value)"];

  // Named for the chart, so two charts' exports differ in the palette.
  const dataset = useMemo(() => ({ ...chartSeriesDataset, name: label }), [label]);
  // Only whether to export: callers pass a fresh exportAs object each render.
  const exporting = exportAs !== undefined;
  const rows = useMemo(
    () => (exporting ? chartRows(series, { metric: label, unit, limit: threshold }) : []),
    [exporting, series, label, unit, threshold],
  );

  // How far along the time axis a point sits, 0 to 1.
  const t0 = series.length ? Date.parse(series[0].t) : 0;
  const span = series.length ? Date.parse(series[series.length - 1].t) - t0 : 0;
  const share = (t: string) => (span > 0 ? (Date.parse(t) - t0) / span : 0);
  // The limit's label leaves the right end to markers labelled there (the
  // right quarter, where "mitigation applied" usually is), unless the left
  // quarter is busier still.
  const placed = markers.map((m) => nearestPoint(series, m.t)).filter((x): x is string => Boolean(x));
  const rightMarkers = placed.filter((x) => share(x) > 0.75).length;
  const leftMarkers = placed.filter((x) => share(x) < 0.25).length;
  const limitOnLeft = rightMarkers > 0 && leftMarkers < rightMarkers;

  const chart = (
    <ChartContainer config={config} className={cn("aspect-auto h-40 w-full", className)}>
      <AreaChart
        data={series}
        // With an export button, the plot ends left of it rather than under it.
        margin={compact ? { left: 0, right: 0, top: 4, bottom: 0 } : { left: 0, right: exporting ? 32 : 8, top: 8, bottom: 0 }}
        className={cn(onSelect && "cursor-crosshair select-none")}
        onMouseMove={(state) => {
          onHover?.(state.isTooltipActive ? series[Number(state.activeTooltipIndex)] : undefined);
          const t = at(state);
          if (drag && t && t !== drag.b) setDrag({ ...drag, b: t });
        }}
        onMouseDown={(state) => {
          const t = at(state);
          if (onSelect && t) setDrag({ a: t, b: t });
        }}
        onMouseUp={finish}
        onMouseLeave={finish}
      >
        <defs>
          <linearGradient id={strokeId} x1="0" y1="0" x2="0" y2="1">
            <stop offset={0} stopColor={above} />
            <stop offset={strokeSplit} stopColor={above} />
            <stop offset={strokeSplit} stopColor={below} />
            <stop offset={1} stopColor={below} />
          </linearGradient>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset={0} stopColor="var(--destructive)" stopOpacity={0.3} />
            <stop offset={fillSplit} stopColor="var(--destructive)" stopOpacity={0.08} />
            <stop offset={fillSplit} stopColor="var(--color-value)" stopOpacity={0.12} />
            <stop offset={1} stopColor="var(--color-value)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        {!compact && <CartesianGrid vertical={false} />}
        <XAxis
          dataKey="t"
          hide={compact}
          tickLine={false}
          axisLine={false}
          minTickGap={48}
          tickFormatter={(t: string) => formatTime(t).slice(0, 5)}
        />
        <YAxis hide={compact} tickLine={false} axisLine={false} width={44} />
        <ChartTooltip
          cursor={compact ? { stroke: "var(--muted-foreground)", strokeWidth: 1 } : undefined}
          // Above the export button, which is above the chart.
          wrapperStyle={exporting ? { zIndex: 20 } : undefined}
          content={
            compact ? (
              () => null
            ) : (
              <ChartTooltipContent labelFormatter={(_, payload) => formatTime(payload[0]?.payload.t)} />
            )
          }
        />
        {threshold !== undefined && (
          // Neutral, like the deploy marker: the red line above it is what
          // shows the breach. "limit" matches the header's wording. Its label
          // goes to the end of the line with fewer marker labels near it, so
          // a limit near the top doesn't print over "mitigation applied".
          <ReferenceLine
            y={threshold}
            stroke="var(--muted-foreground)"
            strokeDasharray="4 4"
            label={
              compact
                ? undefined
                : {
                    value: limitLabel ?? `limit ${threshold}`,
                    position: limitOnLeft ? "insideBottomLeft" : "insideBottomRight",
                    fill: "var(--muted-foreground)",
                    fontSize: 11,
                  }
            }
          />
        )}
        {!compact &&
          markers.toSorted((a, b) => Date.parse(a.t) - Date.parse(b.t)).map((m, i) => {
            const x = nearestPoint(series, m.t);
            // Neighbouring labels take turns on two rows so close markers
            // don't overprint; in the right quarter a label sits left of its
            // line so the chart's edge doesn't cut it off.
            const right = x && share(x) > 0.75;
            return (
              x && (
                <ReferenceLine
                  key={`${m.t}-${m.label}`}
                  x={x}
                  // Fades in once the line is drawn, pointing at the cause.
                  className="animate-in fade-in-0 duration-300 ease-out delay-700 fill-mode-backwards motion-reduce:animate-none"
                  stroke={markerStroke[m.tone ?? "default"]}
                  strokeDasharray="2 3"
                  label={{
                    value: m.label,
                    position: right ? "insideTopRight" : "insideTopLeft",
                    offset: i % 2 ? 19 : 5,
                    fill: "var(--muted-foreground)",
                    fontSize: 11,
                  }}
                />
              )
            );
          })}
        {/* Neutral, so the line inside keeps its own color (a red breach
            stays red); the edges say where the range starts and ends. */}
        {shaded && <ReferenceArea x1={shaded[0]} x2={shaded[1]} fill="var(--foreground)" fillOpacity={0.07} />}
        {shaded?.map((x, i) => (
          <ReferenceLine key={i} x={x} stroke="var(--foreground)" strokeOpacity={0.4} />
        ))}
        <Area
          dataKey="value"
          type="monotone"
          stroke={`url(#${strokeId})`}
          strokeWidth={2}
          fill={`url(#${fillId})`}
          // Recharts' own animation would replay on every refresh; this
          // clip reveal runs once, when the chart mounts.
          isAnimationActive={false}
          className="animate-chart-reveal motion-reduce:animate-none"
        />
      </AreaChart>
    </ChartContainer>
  );
  if (!exportAs) return chart;
  // Over the chart's surface, which spans the gutter and would take its
  // clicks, but under the tooltip (wrapperStyle above).
  return (
    <div className="relative">
      <div className="absolute top-0 right-0 z-10">
        <ExportMenu iconOnly size="xs" exports={[{ dataset, rows, subject: exportAs.subject }]} />
      </div>
      {chart}
    </div>
  );
}
