"use client";

import { useId, useState } from "react";
import { Area, AreaChart, CartesianGrid, ReferenceArea, ReferenceLine, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
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
}

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
  markers = [],
  compact = false,
  onHover,
  selection,
  onSelect,
  className,
}: {
  series: ChartPoint[];
  label: string;
  unit: string;
  threshold?: number;
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
  const strokeSplit = split(min);
  const fillSplit = split(0);

  return (
    <ChartContainer config={config} className={cn("aspect-auto h-40 w-full", className)}>
      <AreaChart
        data={series}
        margin={compact ? { left: 0, right: 0, top: 4, bottom: 0 } : { left: 0, right: 8, top: 8, bottom: 0 }}
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
            <stop offset={0} stopColor="var(--destructive)" />
            <stop offset={strokeSplit} stopColor="var(--destructive)" />
            <stop offset={strokeSplit} stopColor="var(--color-value)" />
            <stop offset={1} stopColor="var(--color-value)" />
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
          // shows the breach. "limit" matches the header's wording.
          <ReferenceLine
            y={threshold}
            stroke="var(--muted-foreground)"
            strokeDasharray="4 4"
            label={
              compact
                ? undefined
                : {
                    value: `limit ${threshold}`,
                    position: "insideBottomRight",
                    fill: "var(--muted-foreground)",
                    fontSize: 11,
                  }
            }
          />
        )}
        {!compact &&
          markers.map((m) => {
            const x = nearestPoint(series, m.t);
            return (
              x && (
                <ReferenceLine
                  key={`${m.t}-${m.label}`}
                  x={x}
                  // Fades in once the line is drawn, pointing at the cause.
                  className="animate-in fade-in-0 duration-300 ease-out delay-700 fill-mode-backwards motion-reduce:animate-none"
                  stroke="var(--muted-foreground)"
                  strokeDasharray="2 3"
                  label={{
                    value: m.label,
                    position: "insideTopLeft",
                    fill: "var(--muted-foreground)",
                    fontSize: 11,
                  }}
                />
              )
            );
          })}
        {shaded && (
          <ReferenceArea x1={shaded[0]} x2={shaded[1]} fill="var(--primary)" fillOpacity={0.12} stroke="var(--primary)" strokeOpacity={0.4} />
        )}
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
}
