"use client";

import { ArrowDownIcon, LoaderCircleIcon, MoveHorizontalIcon, PauseIcon, PlayIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { type ComponentProps, type ReactNode, useEffect, useState } from "react";
import { formatTime } from "@/components/incident/format";
import { type ChartMarker, MetricChart, type TimeRange } from "@/components/incident/metric-chart";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ruleStatuses } from "@/components/watch/rule-filters";
import { useWatchState } from "@/components/watch/watch-client";
import { WatchHeader } from "@/components/watch/watch-header";
import { useLivePoll } from "@/hooks/use-live-poll";
import { useStartInvestigation } from "@/hooks/use-start-investigation";
import { LIVE_ID } from "@/lib/investigation/options";
import { TraceSheet } from "./trace-sheet";
import type { ChartPoint } from "@/lib/investigation/schema";
import {
  type LiveIncident,
  type LiveLog,
  type LiveRequest,
  type LiveRoute,
  type LiveSnapshot,
  type LiveWindow,
  liveService,
  liveWindows,
} from "@/lib/live/types";
import { cn } from "@/lib/utils";

const POLL_MS = 2_000;
// Shopfront exports metrics every 10s even when idle, so this long without
// anything means the service or the collector has stopped.
const STALE_MS = 25_000;

const clock = (t: number) => formatTime(new Date(t).toISOString());

// A clock that ticks every second, for "updated 2s ago".
function useSecondClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const ago = (ms: number) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`);

export function LiveService({ service }: { service: string }) {
  // Only the live service is watched and can be investigated from here; on
  // any other the charts are for looking, without rules or range selection.
  const watched = service === liveService;
  const [range, setRange] = useState<LiveWindow>("5m");
  const [paused, setPaused] = useState(false);
  // The request whose trace is open; it stays open across polls.
  const [traced, setTraced] = useState<LiveRequest>();
  // A range dragged out on a chart. The charts hold still while there is
  // one, so it doesn't scroll away before it's investigated.
  const [selection, setSelection] = useState<TimeRange>();
  const frozen = paused || selection !== undefined;
  const { data, error, updatedAt } = useLivePoll<LiveSnapshot>(
    `/api/live?service=${encodeURIComponent(service)}&window=${range}`,
    POLL_MS,
    !frozen,
  );
  const now = useSecondClock();
  // A window change keeps the last snapshot on screen until the new one
  // arrives, so the charts don't flash empty.
  const snapshot = data?.service === service ? data : undefined;
  // How long the service had been quiet: as of now while live, but as of
  // the held snapshot while paused, so holding still isn't read as silence.
  const asOf = frozen && snapshot ? snapshot.generatedAt : now;
  const silentFor = snapshot?.lastDataAt === undefined ? undefined : asOf - snapshot.lastDataAt;
  const stale = snapshot && (silentFor === undefined || silentFor > STALE_MS);
  const markers: ChartMarker[] = (snapshot?.incidents ?? []).map((i) => ({ t: i.detectedAt, label: "Incident" }));
  const onSelect = watched ? setSelection : undefined;
  // Each chart's points as drawn, the window on screen (held while paused).
  const exportAs = { subject: { kind: "service", id: service, name: service } };

  return (
    // One gap between everything on the page, the same as inside the grids,
    // so no two boxes sit closer or further apart than any others.
    <div className="flex flex-col gap-4">
      <WatchHeader
        crumbs={[{ label: "Services", href: "/services" }]}
        title={service}
        actions={
          <>
            <SegmentedControl
              aria-label="Time window"
              value={range}
              onValueChange={(r) => {
                setRange(r);
                setSelection(undefined);
              }}
              options={liveWindows.map((w) => ({ value: w.id, label: w.label }))}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                // Resuming also lets go of a selection, which holds the charts.
                setPaused(!frozen);
                setSelection(undefined);
              }}
            >
              {frozen ? <PlayIcon /> : <PauseIcon />}
              {frozen ? "Resume" : "Pause"}
            </Button>
          </>
        }
      >
        <LiveIndicator
          paused={frozen}
          held={!paused && selection !== undefined}
          stale={!!stale}
          hasData={!!snapshot}
          heldAt={frozen ? snapshot?.generatedAt : undefined}
          updated={updatedAt === undefined ? undefined : ago(now - updatedAt)}
        />
        {watched && <RuleStates />}
      </WatchHeader>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t refresh</AlertTitle>
          <AlertDescription className="break-words">{error}. Showing the last data received.</AlertDescription>
        </Alert>
      )}
      {stale && (
        <Alert>
          <AlertTitle>
            {silentFor === undefined ? `No telemetry from ${service} yet` : `No data from ${service} for ${ago(silentFor)}`}
          </AlertTitle>
          <AlertDescription>
            Check that {service} and the collector are running (<span className="font-mono text-xs">pnpm infra:up</span>).
          </AlertDescription>
        </Alert>
      )}

      {!snapshot ? (
        <LiveSkeleton />
      ) : (
        <>
          <Tiles snapshot={snapshot} />
          {snapshot.incidents.length > 0 && <IncidentList incidents={snapshot.incidents} />}
          {/* Right above the charts it's about. */}
          {watched && (
            <RangeRow
              service={service}
              selection={selection}
              snapshot={snapshot}
              onClear={() => setSelection(undefined)}
            />
          )}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <ChartCard
              title="Requests per second"
              value={snapshot.overall.perSecond}
              window={snapshot.window}
              unit="req/s"
              series={snapshot.series.perSecond}
              markers={markers}
              selection={selection}
              onSelect={onSelect}
              exportAs={exportAs}
            />
            <ChartCard
              title="p95 latency"
              value={snapshot.overall.p95Ms}
              window={snapshot.window}
              unit="ms"
              series={snapshot.series.p95Ms}
              markers={markers}
              selection={selection}
              onSelect={onSelect}
              threshold={snapshot.limits.p95Ms}
              exportAs={exportAs}
              note={snapshot.limits.p95Ms ? "All routes together; the line is the API latency rule's limit." : undefined}
            />
            <ChartCard
              title="Error rate"
              value={snapshot.overall.errorPercent}
              window={snapshot.window}
              unit="%"
              series={snapshot.series.errorPercent}
              markers={markers}
              selection={selection}
              onSelect={onSelect}
              threshold={snapshot.limits.errorPercent}
              exportAs={exportAs}
            />
            <ChartCard
              title="Database connections in use"
              value={snapshot.overall.poolPeak}
              window={snapshot.window}
              peak
              unit="connections"
              series={snapshot.series.poolUsed}
              markers={markers}
              selection={selection}
              onSelect={onSelect}
              threshold={snapshot.limits.poolMax}
              exportAs={exportAs}
              note={waitingNote(snapshot.series.poolWaiting)}
              empty="No connection pool readings in this window"
            />
          </div>
          <Section title="Routes">
            <RouteTable routes={snapshot.routes} />
          </Section>
          <ActivitySection requests={snapshot.requests} logs={snapshot.logs} onOpenRequest={setTraced} />
        </>
      )}
      <TraceSheet request={traced} onClose={() => setTraced(undefined)} />
    </div>
  );
}

// The page's state, with the last update and the timezone on hover: while
// live the update ticks between 0s and 2s and says nothing the dot doesn't,
// and staleness and failed polls have their own alerts. Paused, the moment
// on screen is what matters, so it shows inline. A selected range holds
// the charts too, and says so, since nobody pressed Pause.
function LiveIndicator({
  paused,
  held,
  stale,
  hasData,
  heldAt,
  updated,
}: {
  paused: boolean;
  held: boolean;
  stale: boolean;
  hasData: boolean;
  heldAt?: number;
  updated?: string;
}) {
  const [label, dot] = paused
    ? [`${held ? "Held" : "Paused"}${heldAt === undefined ? "" : ` · ${clock(heldAt)}`}`, "bg-muted-foreground"]
    : !hasData
      ? ["Connecting", "bg-muted-foreground animate-pulse motion-reduce:animate-none"]
      : stale
        ? ["No data", "bg-warning"]
        : ["Live", "bg-success animate-pulse motion-reduce:animate-none"];
  const detail = [
    held ? "Held while a range is selected" : paused ? undefined : updated && `Updated ${updated} ago`,
    "Times in UTC",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Focusable, so the detail opens from the keyboard too. */}
        <span
          tabIndex={0}
          className="flex cursor-default items-center gap-1.5 rounded-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span aria-hidden className={cn("size-2 rounded-full", dot)} />
          <span className={cn(paused && "tabular-nums")}>{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{detail}</TooltipContent>
    </Tooltip>
  );
}

const SLOWEST = "slowest";

// The row above the charts: a hint while nothing is selected, then the
// selected range with what happened in it and starting an investigation of
// it, of one route or of whichever was slowest (picked on the server). It
// keeps its height either way, so finishing a drag doesn't move the charts.
function RangeRow({
  service,
  selection,
  snapshot,
  onClear,
}: {
  service: string;
  selection?: TimeRange;
  snapshot: LiveSnapshot;
  onClear: () => void;
}) {
  if (!selection) {
    return (
      <div className="flex min-h-11 items-center gap-2 rounded-lg border border-dashed px-4 text-muted-foreground text-xs">
        <MoveHorizontalIcon className="size-4 shrink-0" aria-hidden />
        Drag across a chart to pick a range to investigate
      </div>
    );
  }
  return <SelectedRange service={service} selection={selection} snapshot={snapshot} onClear={onClear} />;
}

function SelectedRange({
  service,
  selection,
  snapshot,
  onClear,
}: {
  service: string;
  selection: TimeRange;
  snapshot: LiveSnapshot;
  onClear: () => void;
}) {
  const [route, setRoute] = useState(SLOWEST);
  const { start, pending, error } = useStartInvestigation();
  const bucketMs = liveWindows.find((w) => w.id === snapshot.window)?.bucketMs ?? 5_000;
  // The selection runs to the end of its last bucket.
  const toMs = Date.parse(selection.to) + bucketMs;
  const to = new Date(toMs).toISOString();
  const names = [...new Set(snapshot.routes.map((r) => r.route))].sort();
  const stats = rangeStats(snapshot, selection, bucketMs);
  const overLimit = snapshot.limits.p95Ms !== undefined && (stats.p95Peak ?? 0) > snapshot.limits.p95Ms;

  // Esc lets go of the range, unless it's closing the route list (Radix
  // handles that first and marks the event).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !e.defaultPrevented) onClear();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClear]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-4 py-1.5 text-sm">
        <span className="flex items-center gap-2">
          <span className="font-mono text-xs tabular-nums">
            {clock(Date.parse(selection.from))} – {clock(toMs)}
            <span className="text-muted-foreground"> UTC</span>
          </span>
          <Badge variant="secondary" className="font-normal tabular-nums">
            {duration(toMs - Date.parse(selection.from))}
          </Badge>
        </span>
        <span aria-hidden className="h-4 w-px bg-border max-sm:hidden" />
        <span className="text-muted-foreground text-xs tabular-nums">
          {stats.requests === 0 ? (
            "No requests in this range"
          ) : (
            <>
              <span className="text-foreground">{stats.perSecond}</span> req/s · p95 peak{" "}
              <span className={cn("text-foreground", overLimit && "text-destructive")}>{stats.p95Peak} ms</span> ·{" "}
              <span className={cn("text-foreground", (stats.errorPercent ?? 0) > 0 && "text-destructive")}>
                {stats.errorPercent}%
              </span>{" "}
              errors
            </>
          )}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Select value={route} onValueChange={setRoute}>
            <SelectTrigger size="sm" aria-label="Route to investigate" className="max-w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SLOWEST}>Slowest route</SelectItem>
              {names.map((r) => (
                <SelectItem key={r} value={r} className="font-mono text-xs">
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" onClick={onClear} className="text-muted-foreground">
            Clear
            <kbd className="rounded border px-1 font-mono text-[10px] text-muted-foreground max-md:hidden">Esc</kbd>
          </Button>
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              void start(LIVE_ID, { service, from: selection.from, to, route: route === SLOWEST ? undefined : route })
            }
          >
            {pending ? <LoaderCircleIcon className="animate-spin" /> : <SearchIcon />}
            Investigate
          </Button>
        </div>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t start the investigation</AlertTitle>
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

// What happened in the selected buckets, from the points the charts drew:
// the request rate, the highest bucket p95, and the share of requests that
// failed (each bucket's rate weighted by its requests).
function rangeStats(snapshot: LiveSnapshot, selection: TimeRange, bucketMs: number) {
  const { perSecond, p95Ms, errorPercent } = snapshot.series;
  const inRange = perSecond.flatMap((p, i) => (p.t >= selection.from && p.t <= selection.to ? [i] : []));
  const seconds = (inRange.length * bucketMs) / 1000;
  const counts = inRange.map((i) => (perSecond[i].value ?? 0) * (bucketMs / 1000));
  const requests = counts.reduce((a, b) => a + b, 0);
  const failed = inRange.reduce((n, i, k) => n + ((errorPercent[i]?.value ?? 0) / 100) * counts[k], 0);
  const peaks = inRange.flatMap((i) => (p95Ms[i]?.value == null ? [] : [p95Ms[i].value as number]));
  return {
    requests: Math.round(requests),
    perSecond: seconds ? Math.round((requests / seconds) * 100) / 100 : 0,
    p95Peak: peaks.length ? Math.max(...peaks) : undefined,
    errorPercent: requests ? Math.round((failed / requests) * 1000) / 10 : undefined,
  };
}

// "45 s", "2 min", "1 min 30 s".
function duration(ms: number) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  if (m === 0) return `${s} s`;
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}

// The watch's rules as it last judged them, each linking to its page.
function RuleStates() {
  const watch = useWatchState();
  if (!watch) return null;
  if (!watch.enabled) return <StatusBadge tone="muted">Watch paused</StatusBadge>;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {watch.rules.map((r) => {
        const status = ruleStatuses.find((s) => s.id === r.status) ?? ruleStatuses[0];
        return (
          <Tooltip key={r.id}>
            <TooltipTrigger asChild>
              <Link href={`/watch/${r.id}`}>
                <StatusBadge tone={status.tone} pulse={r.status === "breaching"} className="hover:bg-muted">
                  {r.name}
                  <span className="text-muted-foreground">
                    {r.status === "breaching" && r.checks ? `${status.label} · ${r.checks} of ${r.needed}` : status.label}
                  </span>
                </StatusBadge>
              </Link>
            </TooltipTrigger>
            <TooltipContent>{r.summary ?? r.description}</TooltipContent>
          </Tooltip>
        );
      })}
    </span>
  );
}

// A card like the charts', since it's about the same window.
function IncidentList({ incidents }: { incidents: LiveIncident[] }) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-medium text-sm">Incidents in this window</h2>
        <span className="font-mono text-muted-foreground text-xs tabular-nums">{incidents.length}</span>
      </div>
      <ul className="-mx-2 flex flex-col">
        {incidents.map((i) => (
          <li key={i.id}>
            <Link
              href={`/incidents/${i.id}`}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/50"
            >
              <span className="font-mono text-muted-foreground text-xs tabular-nums">{clock(Date.parse(i.detectedAt))}</span>
              <span className="min-w-0 flex-1 truncate">{i.title}</span>
              <span className="shrink-0 text-muted-foreground text-xs">{i.rule ? `Watch · ${i.rule}` : "Opened by a person"}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function waitingNote(series: ChartPoint[]) {
  const peak = Math.max(0, ...series.map((p) => p.value ?? 0));
  return peak > 0 ? `Up to ${peak} request${peak === 1 ? "" : "s"} waited for a connection in this window.` : undefined;
}

function Tiles({ snapshot }: { snapshot: LiveSnapshot }) {
  const { now, limits } = snapshot;
  const tiles: { label: string; value: string; over?: boolean }[] = [
    { label: "Requests", value: `${now.perSecond} /s` },
    {
      label: "p95 latency",
      value: now.p95Ms === undefined ? "—" : `${now.p95Ms} ms`,
      over: limits.p95Ms !== undefined && now.p95Ms !== undefined && now.p95Ms > limits.p95Ms,
    },
    {
      label: "Error rate",
      value: now.errorPercent === undefined ? "—" : `${now.errorPercent}%`,
      over: limits.errorPercent !== undefined && now.errorPercent !== undefined && now.errorPercent > limits.errorPercent,
    },
    {
      label: "Connections in use",
      value: now.poolUsed === undefined ? "—" : `${now.poolUsed}${now.poolMax ? ` / ${now.poolMax}` : ""}`,
      over: now.poolMax !== undefined && now.poolUsed !== undefined && now.poolUsed >= now.poolMax,
    },
  ];
  return (
    <section aria-label="Last 30 seconds" className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="flex flex-col gap-1 rounded-lg border p-4">
            {/* Each tile says its own span, so it isn't read as the window's. */}
            <span className="flex flex-wrap items-baseline justify-between gap-x-2 text-muted-foreground text-xs">
              {t.label}
              <span className="text-muted-foreground/70">last 30 s</span>
            </span>
            <span className={cn("font-medium font-mono text-lg tabular-nums", t.over && "text-destructive")}>{t.value}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ChartCard({
  title,
  value,
  window,
  peak = false,
  unit,
  series,
  threshold,
  markers,
  selection,
  onSelect,
  exportAs,
  note,
  empty = "No requests in this window",
}: {
  title: string;
  // Over the whole window, like the chart; `peak` when it's the highest
  // reading rather than a figure over every request.
  value?: number;
  window: LiveWindow;
  peak?: boolean;
  unit: string;
  series: ChartPoint[];
  threshold?: number;
  markers?: ChartMarker[];
  selection?: TimeRange;
  onSelect?: (range: TimeRange | undefined) => void;
  exportAs?: ComponentProps<typeof MetricChart>["exportAs"];
  note?: string;
  // What to say when every point is a gap.
  empty?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="font-medium text-sm">{title}</h3>
        <span className="font-mono text-muted-foreground text-xs tabular-nums">
          {value === undefined ? "—" : `${peak ? "peak " : ""}${value} ${unit}`}
          <span className="text-muted-foreground/70"> · {window}</span>
        </span>
      </div>
      {series.every((p) => p.value === null) ? (
        <div className="flex h-40 items-center justify-center text-muted-foreground text-sm">{empty}</div>
      ) : (
        <MetricChart
          series={series}
          label={title}
          unit={unit}
          threshold={threshold}
          markers={markers}
          selection={selection}
          onSelect={onSelect}
          exportAs={exportAs}
        />
      )}
      {note && <p className="text-muted-foreground text-xs">{note}</p>}
    </div>
  );
}

// A titled part of the page; `actions` sit at the right of the title's row,
// for controls that change what the section shows.
function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium text-sm">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

type RouteSort = "requests" | "p95Ms" | "errorPercent";

function RouteTable({ routes }: { routes: LiveRoute[] }) {
  const [sort, setSort] = useState<RouteSort>("requests");
  if (routes.length === 0) {
    return <p className="text-muted-foreground text-sm">No requests in this window.</p>;
  }
  const sorted = [...routes].sort((a, b) => b[sort] - a[sort]);
  const header = (key: RouteSort, label: string) => (
    <TableHead className="text-right" aria-sort={sort === key ? "descending" : undefined}>
      <button
        type="button"
        onClick={() => setSort(key)}
        className={cn("inline-flex items-center gap-1 hover:text-foreground", sort === key && "text-foreground")}
      >
        {label}
        {sort === key && <ArrowDownIcon className="size-3" />}
      </button>
    </TableHead>
  );
  // The outer columns inset 16px, like every other box on the page.
  return (
    <div className="rounded-lg border [&_tr>*:first-child]:pl-4 [&_tr>*:last-child]:pr-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Route</TableHead>
            {header("requests", "Requests")}
            <TableHead className="text-right">Per second</TableHead>
            {header("p95Ms", "p95")}
            {header("errorPercent", "Errors")}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((r) => (
            <TableRow key={`${r.method} ${r.route}`}>
              <TableCell className="max-w-0 truncate font-mono text-xs">
                <span className="text-muted-foreground">{r.method}</span> {r.route}
              </TableCell>
              <TableCell className="text-right font-mono text-xs tabular-nums">{r.requests}</TableCell>
              <TableCell className="text-right font-mono text-xs tabular-nums">{r.perSecond}</TableCell>
              <TableCell
                className={cn(
                  "text-right font-mono text-xs tabular-nums",
                  r.limitMs !== undefined && r.p95Ms > r.limitMs && "text-destructive",
                )}
              >
                {r.limitMs === undefined ? (
                  `${r.p95Ms} ms`
                ) : (
                  <Tooltip>
                    <TooltipTrigger className="cursor-default">{r.p95Ms} ms</TooltipTrigger>
                    <TooltipContent>Limit {r.limitMs} ms</TooltipContent>
                  </Tooltip>
                )}
              </TableCell>
              <TableCell
                className={cn("text-right font-mono text-xs tabular-nums", r.errorPercent > 0 && "text-destructive")}
              >
                {r.errorPercent}%
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

const levelBadge: Record<LiveLog["level"], "destructive" | "warning" | "secondary" | "outline"> = {
  error: "destructive",
  warn: "warning",
  info: "secondary",
  debug: "outline",
};

type ActivityView = "requests" | "logs";

// The newest requests or logs, picked with the same kind of switch as the
// page's time window, on the section's title row.
function ActivitySection({
  requests,
  logs,
  onOpenRequest,
}: {
  requests: LiveRequest[];
  logs: LiveLog[];
  onOpenRequest: (request: LiveRequest) => void;
}) {
  const [view, setView] = useState<ActivityView>("requests");
  return (
    <Section
      title="Activity"
      actions={
        <SegmentedControl
          aria-label="Activity to show"
          value={view}
          onValueChange={setView}
          options={[
            { value: "requests", label: "Requests" },
            { value: "logs", label: "Logs" },
          ]}
        />
      }
    >
      {view === "requests" ? (
        requests.length === 0 ? (
          <p className="py-2 text-muted-foreground text-sm">No requests in this window.</p>
        ) : (
          <ol className="divide-y rounded-lg border font-mono text-xs">
            {requests.map((r) => (
              <li key={`${r.traceId}-${r.time}`}>
                <button
                  type="button"
                  onClick={() => onOpenRequest(r)}
                  aria-label={`Show the trace of ${r.method} ${r.route} at ${clock(r.time)}`}
                  className={cn(
                    "grid w-full grid-cols-[4.5rem_3rem_minmax(0,1fr)_3rem_4.5rem] gap-3 px-4 py-1.5 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none",
                    r.failed && "bg-destructive/5",
                  )}
                >
                  <span className="text-muted-foreground tabular-nums">{clock(r.time)}</span>
                  <span className="text-muted-foreground">{r.method}</span>
                  <span className="truncate">{r.route}</span>
                  <span className={cn("tabular-nums", r.failed && "text-destructive")}>{r.status || "—"}</span>
                  <span className="text-right tabular-nums">{r.durationMs} ms</span>
                </button>
              </li>
            ))}
          </ol>
        )
      ) : logs.length === 0 ? (
        <p className="py-2 text-muted-foreground text-sm">No logs in this window.</p>
      ) : (
        <ol className="divide-y rounded-lg border text-xs">
          {logs.map((l, i) => {
            const fields = Object.entries(l.attributes ?? {});
            // The request this line belongs to, when it is in the feed too.
            const request = l.traceId ? requests.find((r) => r.traceId === l.traceId) : undefined;
            return (
              <li
                // Logs have no id; time and position tell them apart.
                key={`${l.time}-${i}`}
                className={cn(
                  "grid grid-cols-[4.5rem_3.5rem_minmax(0,1fr)_auto] items-start gap-3 px-4 py-1.5",
                  l.level === "error" && "bg-destructive/5",
                )}
              >
                <span className="font-mono text-muted-foreground tabular-nums">{clock(l.time)}</span>
                <Badge variant={levelBadge[l.level]} className="uppercase">
                  {l.level}
                </Badge>
                <span className="min-w-0 break-words font-mono">
                  {l.body}
                  {fields.length > 0 && (
                    <span className="text-muted-foreground">
                      {fields.map(([key, value]) => (
                        <span key={key} className="ml-2 inline-block">
                          {key}=<span className="text-foreground/80">{String(value)}</span>
                        </span>
                      ))}
                    </span>
                  )}
                </span>
                {request ? (
                  <button
                    type="button"
                    onClick={() => onOpenRequest(request)}
                    aria-label={`Show the trace of ${request.method} ${request.route} at ${clock(request.time)}`}
                    className="font-mono text-muted-foreground tabular-nums hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
                  >
                    {l.traceId?.slice(0, 8)}
                  </button>
                ) : (
                  <span className="font-mono text-muted-foreground/50 tabular-nums">{l.traceId?.slice(0, 8) ?? ""}</span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Section>
  );
}

function LiveSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-56" />
        ))}
      </div>
    </div>
  );
}
