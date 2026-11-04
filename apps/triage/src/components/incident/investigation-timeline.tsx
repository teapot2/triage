"use client";

import {
  ArrowDownIcon,
  BrainIcon,
  ChartLineIcon,
  ChevronRightIcon,
  CircleXIcon,
  DatabaseIcon,
  FileCodeIcon,
  FolderTreeIcon,
  GitCommitHorizontalIcon,
  GlobeIcon,
  LibraryBigIcon,
  LoaderCircleIcon,
  type LucideIcon,
  PackageIcon,
  RocketIcon,
  ScrollTextIcon,
  SearchIcon,
  SearchXIcon,
  TextSearchIcon,
  WaypointsIcon,
} from "lucide-react";
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChangedSinceMount } from "@/hooks/use-changed-since-mount";
import { useCountUp } from "@/hooks/use-count-up";
import { scrollToEnd, useFollowBottom } from "@/hooks/use-follow-bottom";
import { incidentSubject, investigationTrace, traceRows } from "@/lib/export/datasets/incident";
import type { InvestigationStep, Run, Thought, ToolName } from "@/lib/investigation/schema";
import { cn } from "@/lib/utils";
import { ContextMeter } from "./context-meter";
import { leadRecord } from "./hypotheses-checked";
import { Citations, evidenceIcons, useEvidence } from "./evidence";
import { modelLabel, providerLabels } from "@/lib/models/labels";
import { formatDuration, formatTime } from "./format";
import { useIncident } from "./incident-export";
import { evidenceTitle } from "./metric-labels";
import { LaneTag } from "./lane-tag";
import { laneOptions } from "./lanes";
import { activeFilterCount, emptyFilters, type Filters, filterSteps, filterThoughts, matchSnippet } from "./log-filters";
import { LogToolbar } from "./log-toolbar";
import { countTurns, groupTurns, type Turn, turnTiming } from "./turns";

// A finished tool call shows what kind of call it was, so a metrics query,
// a log search and a source read look different at a glance; a running one
// spins and a failed one shows a cross instead.
const toolIcons: Record<ToolName, LucideIcon> = {
  query_metrics: ChartLineIcon,
  query_logs: ScrollTextIcon,
  query_traces: WaypointsIcon,
  db_diagnostics: DatabaseIcon,
  deploy_history: RocketIcon,
  git_log: GitCommitHorizontalIcon,
  read_source: FileCodeIcon,
  web_search: GlobeIcon,
  dependency_audit: PackageIcon,
  list_files: FolderTreeIcon,
  grep_source: TextSearchIcon,
  full_context: LibraryBigIcon,
};

const statusIcons = {
  running: { Icon: LoaderCircleIcon, className: "animate-spin text-muted-foreground" },
  error: { Icon: CircleXIcon, className: "text-destructive" },
};

// Rows and phases the agent adds while it runs ease in; on a finished
// investigation everything is already there, so nothing moves.
const enterMotion = "animate-in fade-in-0 slide-in-from-top-1 duration-200 ease-out motion-reduce:animate-none";

// The opened evidence's source flashes as the panel closes, then holds the
// highlight a few seconds, so the eye lands on it.
const highlightFlash = "animate-highlight-flash motion-reduce:animate-none";
// The opened evidence's source: a neutral wash, a step stronger than a row's
// hover, and kept on hover so pointing at it doesn't fade it.
const highlightBg = "bg-foreground/10 hover:bg-foreground/10";

// The phases an investigation moves through, by the tool used. A tool
// this build doesn't know (a record from a newer one) counts as code.
type Phase = "metrics" | "logs" | "database" | "changes" | "code" | "web";

const phaseOf: Record<ToolName, Phase> = {
  query_metrics: "metrics",
  query_logs: "logs",
  query_traces: "logs",
  db_diagnostics: "database",
  deploy_history: "changes",
  git_log: "changes",
  read_source: "code",
  web_search: "web",
  dependency_audit: "changes",
  list_files: "code",
  grep_source: "code",
  full_context: "code",
};

const phaseLabels: Record<Phase, string> = {
  metrics: "Metrics",
  logs: "Logs and traces",
  database: "Database",
  changes: "What changed",
  code: "Code",
  web: "The web",
};

interface PhaseGroup {
  phase: Phase;
  steps: InvestigationStep[];
}

type TimelineView = "phases" | "steps";

// Phases in the order the agent first reached them.
function groupByPhase(steps: InvestigationStep[]): PhaseGroup[] {
  const groups = new Map<Phase, InvestigationStep[]>();
  for (const step of steps) {
    const phase = phaseOf[step.tool] ?? "code";
    groups.set(phase, [...(groups.get(phase) ?? []), step]);
  }
  return [...groups].map(([phase, groupSteps]) => ({ phase, steps: groupSteps }));
}

// The investigation as one timeline grouped by phase: the Investigation
// section of the report. Each phase leads with its evidence, numbered like
// the citations: just what the diagnosis cites, or all of it. Its tool calls
// fold below. While the agent runs, or while searching or filtering, the
// tool calls show directly.
//
// With the model's thinking recorded, a second view lays the run out step by
// step instead: each model call's thinking, then the tool calls it made, in
// order. It's the default while the agent runs, to follow along. On a
// fan-out run each row there names its lane, and Lane filters by it.
export function InvestigationTimeline({
  steps,
  thoughts = [],
  cited,
  running,
  run,
}: {
  steps: InvestigationStep[];
  thoughts?: Thought[];
  cited: string[];
  running: boolean;
  run?: Run;
}) {
  const [chosenView, setView] = useState<TimelineView>();
  // Step by step when the page opened on a running investigation, and it
  // stays so when the run ends, rather than switching under the reader.
  const [openedLive] = useState(running);
  const view: TimelineView = thoughts.length > 0 ? (chosenView ?? (openedLive ? "steps" : "phases")) : "phases";
  const { byId, numberOf, open, focused, covered } = useEvidence();
  const incident = useIncident();
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [searchOpen, setSearchOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<Phase>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const filtering = query.trim() !== "" || activeFilterCount(filters) > 0;
  const shown = useMemo(() => filterSteps(steps, query, filters, byId), [steps, query, filters, byId]);
  const groups = useMemo(() => groupByPhase(filtering ? shown : steps), [filtering, shown, steps]);
  const citedSet = useMemo(() => new Set(cited), [cited]);
  // The counts on Cited and All evidence: what the phases can list, the
  // evidence this run's tool calls returned. byId also holds every Ask
  // answer's evidence, and a citation of an ID it doesn't know lists nothing.
  const runEvidence = useMemo(
    () => new Set(steps.flatMap((s) => s.evidenceIds).filter((id) => byId.has(id))),
    [steps, byId],
  );
  const citedCount = useMemo(() => [...citedSet].filter((id) => runEvidence.has(id)).length, [citedSet, runEvidence]);
  // Offsets count from the first thing that happened: the model's first
  // thought, where it's recorded, comes before the first tool call.
  const firsts = [steps[0]?.startedAt, thoughts[0]?.startedAt].flatMap((t) => (t ? [Date.parse(t)] : []));
  const t0 = firsts.length ? Math.min(...firsts) : 0;
  const showCallsByDefault = filtering || running || cited.length === 0;
  const took = run?.finishedAt ? formatDuration(Date.parse(run.finishedAt) - Date.parse(run.startedAt)) : undefined;
  // Ticks up as the agent adds calls, rather than jumping.
  const callCount = Math.round(useCountUp(steps.length, { duration: 400 }));
  const turnCount = countTurns(steps);
  // A turn's own calls, whatever a search or filter leaves on show, for its
  // caption.
  const callsByTurn = useMemo(() => Map.groupBy(steps, (s) => s.turn), [steps]);
  // A fan-out run's lanes; none on a single-agent run, which then shows no
  // labels and no Lane filter.
  const lanes = useMemo(() => laneOptions(steps, thoughts), [steps, thoughts]);

  // While the agent runs, the page follows its newest row, as long as the
  // reader is at the bottom; scrolling up to read stops it. Not while
  // searching or filtering, or while a citation's source is brought into
  // view. The live thought grows as it streams, so its length counts too.
  const latest = thoughts.at(-1);
  const progress =
    steps.length + thoughts.length + (latest?.reasoning?.length ?? 0) + (latest?.text?.length ?? 0);
  const following = useFollowBottom(noBox, noBox, running && !filtering && !focused ? progress : undefined, true);
  // Rows added since the reader scrolled away offer a way back down.
  const [seen, setSeen] = useState(steps.length + thoughts.length);
  if (following && seen !== steps.length + thoughts.length) setSeen(steps.length + thoughts.length);
  const behind = running && !filtering && !following && steps.length + thoughts.length > seen;
  const jumpToLatest = () => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scrollToEnd(null, null, reduce ? "auto" : "smooth");
  };

  // "/" opens search and focuses it, as in Sentry and GitHub.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      e.preventDefault();
      setSearchOpen(true);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // When a citation is opened, bring its source into view, beside the docked
  // panel or behind the sheet.
  // First expand its phase if it's only among the folded tool calls; that's
  // state derived from a changed value, so it's set during render (React's
  // pattern for it), and the effect below only scrolls.
  const [lastFocused, setLastFocused] = useState<string | null>(null);
  if (focused !== lastFocused) {
    setLastFocused(focused);
    const step = focused ? steps.find((s) => s.evidenceIds.includes(focused)) : undefined;
    if (focused && step && !citedSet.has(focused)) {
      const phase = phaseOf[step.tool] ?? "code";
      if (!expanded.has(phase)) setExpanded(new Set(expanded).add(phase));
    }
  }
  useEffect(() => {
    if (!focused) return;
    const timer = setTimeout(() => {
      const el = rootRef.current?.querySelector(
        `[data-evidence-id="${focused}"], [data-evidence-ids~="${focused}"]`,
      );
      if (!el) return;
      const r = el.getBoundingClientRect();
      // Under the sheet it's instant: a smooth scroll would be invisible and
      // only slower. Beside the docked panel it's in view, so it glides.
      if (r.top < 0 || r.bottom > window.innerHeight) {
        el.scrollIntoView({ block: "center", behavior: covered ? "instant" : "smooth" });
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [focused, covered]);

  const clearAll = () => {
    setQuery("");
    setFilters(emptyFilters);
    inputRef.current?.focus();
  };
  const toggleSearch = () => {
    if (searchOpen && !filtering) {
      setSearchOpen(false);
      return;
    }
    setSearchOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  // Step by step: each thought, with the tool calls it led to nested under
  // it, in the order they happened (filterThoughts says which thoughts a
  // filter leaves).
  const shownThoughts = filterThoughts(thoughts, query, filters);
  const turns = groupTurns(thoughts, shownThoughts, filtering ? shown : steps);
  const rowCount = shownThoughts.length + (filtering ? shown : steps).length;
  const lastThought = thoughts.at(-1)?.id;
  const nothingShown = view === "phases" ? groups.length === 0 : rowCount === 0;
  // The rows on show, in the trace export's shape, to hand on what a
  // search found. The phases view shows no thoughts.
  const exportAs = incident && {
    dataset: investigationTrace,
    rows: traceRows({ run, steps: shown, thoughts: view === "steps" ? shownThoughts : [] }),
    subject: incidentSubject(incident),
  };
  const changeView = (next: TimelineView) => {
    setView(next);
    // Type and Lane are step-by-step filters; the phases hold only tool
    // calls, and stay as on a single-agent run.
    if (next === "phases" && (filters.kind.length > 0 || filters.lane.length > 0)) {
      setFilters({ ...filters, kind: [], lane: [] });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
        <span className="tabular-nums">
          {took && `${took} · `}
          {callCount} tool {callCount === 1 ? "call" : "calls"}
          {turnCount !== undefined && ` in ${turnCount} ${turnCount === 1 ? "turn" : "turns"}`}
          {run && ` · ${modelLabel(run.model, run.provider, run.reasoningEffort)}`}
        </span>
        {run?.rejectedReports ? <SentBack count={run.rejectedReports} problems={run.reportRejections} /> : null}
        {/* A fan-out's lanes and its lead are separate contexts: the
            fullest of them. */}
        {run && <ContextMeter records={[run, ...(run.fanout ? [leadRecord(run.fanout)] : [])]} />}
        <div className="ml-auto flex items-center gap-2">
          {thoughts.length > 0 && (
            <PillToggle
              label="Timeline view"
              value={view}
              onChange={changeView}
              options={[
                { value: "phases", label: "By phase" },
                { value: "steps", label: "Step by step" },
              ]}
            />
          )}
          {/* What the diagnosis cites is marked per phase, so it's a
              phase-view choice. */}
          {view === "phases" && citedCount > 0 && (
            <PillToggle
              label="Evidence shown"
              value={showAll ? "all" : "cited"}
              onChange={(v) => setShowAll(v === "all")}
              options={[
                { value: "cited", label: "Cited", count: citedCount },
                { value: "all", label: "All evidence", count: runEvidence.size },
              ]}
            />
          )}
          <Button
            variant={searchOpen || filtering ? "secondary" : "ghost"}
            size="icon-xs"
            aria-label="Search and filter tool calls"
            aria-pressed={searchOpen || filtering}
            onClick={toggleSearch}
          >
            <SearchIcon />
          </Button>
        </div>
      </div>
      <div ref={rootRef} className="flex flex-col gap-3">
        {(searchOpen || filtering) && (
          <LogToolbar
            steps={steps}
            query={query}
            onQueryChange={setQuery}
            filters={filters}
            onFiltersChange={setFilters}
            shown={view === "steps" ? rowCount : shown.length}
            total={view === "steps" ? steps.length + thoughts.length : steps.length}
            thoughtCount={view === "steps" ? thoughts.length : 0}
            lanes={view === "steps" ? lanes : []}
            inputRef={inputRef}
            exportAs={exportAs}
          />
        )}

        {nothingShown && !filtering ? (
          // Nothing recorded yet (the run has just started, or its model is
          // still waking), or a run that ended before calling a tool.
          <div className="flex flex-col items-center gap-1 rounded-md border border-dashed py-6 text-center">
            {running ? (
              <>
                <LoaderCircleIcon className="mb-1 size-5 animate-spin text-muted-foreground" />
                <p className="font-medium text-sm">Waiting for the first tool call…</p>
                <p className="max-w-md text-muted-foreground text-xs">
                  {run?.wakingSince
                    ? `Starting the ${providerLabels[run.provider ?? ""] ?? "model's"} deployment. After it scales to zero, its first start takes a few minutes.`
                    : "Each call shows here as the agent makes it."}
                </p>
              </>
            ) : (
              <>
                <p className="font-medium text-sm">No tool calls</p>
                <p className="text-muted-foreground text-xs">
                  {thoughts.length > 0 ? "Step by step shows what the model thought." : "The run ended before calling a tool."}
                </p>
              </>
            )}
          </div>
        ) : nothingShown ? (
          // Held back a beat, so it doesn't flash while a query is still being typed.
          <div className="flex flex-col items-center gap-1 rounded-md border border-dashed py-6 text-center animate-in fade-in-0 delay-150 fill-mode-backwards duration-200 ease-out motion-reduce:animate-none">
            <SearchXIcon className="mb-1 size-5 text-muted-foreground" />
            <p className="font-medium text-sm">{view === "steps" ? "Nothing matches" : "No tool calls match"}</p>
            <p className="text-muted-foreground text-xs">Try a different search or remove a filter.</p>
            <Button variant="outline" size="sm" onClick={clearAll} className="mt-2">
              Clear search and filters
            </Button>
          </div>
        ) : view === "steps" ? (
          <ol className="-mx-2 flex flex-col">
            {turns.map((turn) => (
              <Fragment key={turn.key}>
                {turn.thought && (
                  <ThoughtRow
                    thought={turn.thought}
                    lane={turn.thought.lane && <LaneTag lane={turn.thought.lane} fanout={run?.fanout} />}
                    offsetMs={Date.parse(turn.thought.startedAt) - t0}
                    live={running && turn.thought.id === lastThought}
                    running={running}
                  />
                )}
                {turn.steps.length > 0 && (
                  <li>
                    {/* Under a thought, its calls hang off a rail from the
                        thought's icon (15px: the row's padding and half the
                        icon). Calls one model call made together get the
                        rail with or without a thought, tinted, and a caption
                        saying they ran at once. */}
                    <ol
                      className={cn(
                        "flex flex-col",
                        (turn.thought || parallel(turn)) && "ml-[15px] border-l pl-1.5",
                        parallel(turn) && "border-brand/40",
                      )}
                    >
                      {parallel(turn) && <ParallelCaption steps={callsByTurn.get(turn.key) ?? turn.steps} running={running} />}
                      {turn.steps.map((step) => (
                        <StepRow
                          key={step.id}
                          step={step}
                          lane={step.lane && <LaneTag lane={step.lane} fanout={run?.fanout} />}
                          offsetMs={Date.parse(step.startedAt) - t0}
                          query={query}
                          snippet={matchSnippet(step, query, byId)}
                          highlighted={focused !== null && step.evidenceIds.includes(focused)}
                          running={running}
                        />
                      ))}
                    </ol>
                  </li>
                )}
              </Fragment>
            ))}
          </ol>
        ) : (
          <ol className="flex flex-col">
            {groups.map(({ phase, steps: phaseSteps }, i) => {
              const findings = filtering
                ? []
                : [...new Set(phaseSteps.flatMap((s) => s.evidenceIds))]
                    .filter((id) => (showAll || citedSet.has(id)) && byId.has(id))
                    .sort((a, b) => (numberOf.get(a) ?? 0) - (numberOf.get(b) ?? 0));
              const callsOpen = showCallsByDefault || findings.length === 0 || expanded.has(phase);
              const rows = (
                <ol className="-mx-2 flex flex-col">
                  {phaseSteps.map((step) => (
                    <StepRow
                      key={step.id}
                      step={step}
                      offsetMs={Date.parse(step.startedAt) - t0}
                      query={query}
                      snippet={matchSnippet(step, query, byId)}
                      highlighted={focused !== null && step.evidenceIds.includes(focused)}
                      running={running}
                    />
                  ))}
                </ol>
              );

              return (
                <li key={phase} className={cn("relative flex gap-3 pb-5 last:pb-0", running && enterMotion)}>
                  <div className="flex flex-col items-center">
                    <span className="mt-1.5 size-2 shrink-0 rounded-full bg-muted-foreground/50" />
                    {i < groups.length - 1 && <span className="mt-1 w-px flex-1 bg-border" />}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span className="font-medium text-sm">{phaseLabels[phase]}</span>

                    {findings.length > 0 && (
                      <ul className="-mx-2 flex flex-col">
                        {findings.map((id) => {
                          const e = byId.get(id)!;
                          const Icon = evidenceIcons[e.kind];
                          return (
                            <li key={id}>
                              <button
                                type="button"
                                data-evidence-id={id}
                                onClick={() => open(id)}
                                className={cn(
                                  "grid w-full grid-cols-[1.25rem_auto_minmax(0,1fr)] items-center gap-x-2 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-muted/50",
                                  focused === id && highlightBg,
                                  focused === id && !covered && highlightFlash,
                                )}
                              >
                                <span className="inline-flex h-4 min-w-4 items-center justify-center justify-self-start rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground tabular-nums">
                                  {numberOf.get(id)}
                                </span>
                                <Icon className="size-3.5 text-muted-foreground" />
                                <span className="truncate text-muted-foreground">{evidenceTitle(e)}</span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}

                    {findings.length > 0 && !showCallsByDefault ? (
                      <Collapsible
                        open={callsOpen}
                        onOpenChange={(o) =>
                          setExpanded((prev) => {
                            const next = new Set(prev);
                            if (o) next.add(phase);
                            else next.delete(phase);
                            return next;
                          })
                        }
                        className="group/calls"
                      >
                        <CollapsibleTrigger className="flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground">
                          <ChevronRightIcon className="size-3.5 transition-[rotate] duration-200 group-data-[state=open]/calls:rotate-90 motion-reduce:transition-none" />
                          {phaseSteps.length} tool {phaseSteps.length === 1 ? "call" : "calls"}
                        </CollapsibleTrigger>
                        {/* The content clips (for its height animation), and
                            the rows reach 8px past each side so their
                            highlight lines up with the findings'. Widen the
                            clip by as much and pad it back, so the highlight's
                            padding and rounded corners aren't cut off. */}
                        <CollapsibleContent className="-mx-2">
                          <div className="px-2 pt-1">{rows}</div>
                        </CollapsibleContent>
                      </Collapsible>
                    ) : (
                      rows
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      {/* Held at the window's bottom edge while there's more below; no
          height of its own, so it doesn't move the rows. */}
      {behind && (
        <div className="sticky bottom-6 z-10 flex h-0 justify-center">
          <Button
            variant="secondary"
            size="sm"
            onClick={jumpToLatest}
            className="absolute bottom-0 rounded-full shadow-md animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-out motion-reduce:animate-none"
          >
            <ArrowDownIcon />
            Jump to latest
          </Button>
        </div>
      )}
    </div>
  );
}

// No scrolling box: the timeline scrolls with the page.
const noBox = { current: null };

// "· 1 report sent back by validation": submissions the report's checks
// rejected and returned to the model to fix, with what each got wrong on
// hover where the run kept it.
function SentBack({ count, problems = [] }: { count: number; problems?: string[] }) {
  const label = `${count} ${count === 1 ? "report" : "reports"} sent back by validation`;
  if (problems.length === 0) return <span className="tabular-nums">· {label}</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default tabular-nums decoration-dotted underline-offset-4 hover:underline">· {label}</span>
      </TooltipTrigger>
      <TooltipContent className="block max-w-96">
        <ol className="flex list-decimal flex-col gap-1 pl-4">
          {problems.map((p, i) => (
            <li key={i} className="break-words">
              {p}
            </li>
          ))}
        </ol>
      </TooltipContent>
    </Tooltip>
  );
}

// Two or more calls known to come from one model call.
const parallel = (turn: Turn) => turn.together && turn.steps.length > 1;

// "4 calls at once · 1.92 s", and what they'd have taken one after another
// when that's at least half as long again. Times once every call is done.
function ParallelCaption({ steps, running }: { steps: InvestigationStep[]; running: boolean }) {
  const { calls, wallMs, serialMs } = turnTiming(steps);
  return (
    <li className={cn("px-2 pt-1 pb-0.5 text-muted-foreground text-xs", running && enterMotion)}>
      <span className="font-medium text-foreground">{calls} calls at once</span>
      {wallMs !== undefined && (
        <span className="tabular-nums">
          {" · "}
          {formatDuration(wallMs)}
          {serialMs !== undefined && serialMs >= 1.5 * wallMs && ` (${formatDuration(serialMs)} one after another)`}
        </span>
      )}
    </li>
  );
}

export function StepRow({
  step,
  lane,
  offsetMs,
  query,
  snippet,
  highlighted,
  running,
}: {
  step: InvestigationStep;
  // A fan-out run's lane label. Only the step-by-step view passes one: the
  // phases stay as on a single-agent run.
  lane?: ReactNode;
  offsetMs: number;
  query: string;
  snippet?: string;
  highlighted: boolean;
  running: boolean;
}) {
  const { covered } = useEvidence();
  // The highlight sits on the Collapsible, not the li, so its flash and the
  // li's entrance never compete for the same animation.
  return (
    <li data-evidence-ids={step.evidenceIds.join(" ")} className={cn(running && enterMotion)}>
      <Collapsible
        className={cn(
          "group/step rounded-md transition-colors",
          highlighted && highlightBg,
          highlighted && !covered && highlightFlash,
        )}
      >
        {/* Grid so a search snippet can sit under the summary column. */}
        <CollapsibleTrigger className="grid w-full grid-cols-[auto_7rem_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/50">
          <StepStatusIcon status={step.status} tool={step.tool} />
          <span className="font-mono text-xs">
            <Highlight text={step.tool} query={query} />
          </span>
          <span className="truncate text-muted-foreground">
            <Highlight text={step.error ?? step.summary ?? "Running…"} query={query} />
          </span>
          {/* How long the call took, then when it started, to the
              millisecond. The absolute start time is on hover. A fan-out
              run's lane leads, so the lanes line up down the list; on a
              phone it takes the start time's place, which stays on hover. */}
          <span
            className="flex items-baseline gap-2 font-mono text-muted-foreground text-xs tabular-nums"
            title={`Started ${formatTimeMs(step.startedAt)} UTC${step.durationMs !== undefined ? `, took ${formatDuration(step.durationMs)}` : ""}`}
          >
            {lane}
            <span className="w-14 text-right opacity-70">
              {step.durationMs !== undefined ? formatDuration(step.durationMs) : step.status === "running" ? "…" : ""}
            </span>
            <span className={cn(lane && "max-sm:hidden")}>{formatOffset(offsetMs)}</span>
          </span>
          {snippet && (
            <span className="col-span-2 col-start-3 truncate font-mono text-[11px] text-muted-foreground/80">
              <Highlight text={snippet} query={query} />
            </span>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mb-2 ml-8 flex flex-col gap-1.5 border-l pl-3 font-mono text-muted-foreground text-xs">
            {Object.entries(step.input).map(([key, value]) => (
              <span key={key} className="break-all">
                {key}:{" "}
                <span className="text-foreground">
                  <Highlight text={typeof value === "string" ? value : JSON.stringify(value)} query={query} />
                </span>
              </span>
            ))}
            {step.evidenceIds.length > 0 && (
              <span className="flex items-center gap-1.5 font-sans">
                Evidence <Citations ids={step.evidenceIds} />
              </span>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

// A model call's thinking, as a row among the tool calls: "Thinking…" while
// the model works, then what it wrote alongside its calls (or a line of its
// reasoning) and how long it took. Open, that line shows in full and below
// it only what it doesn't already say: the reasoning, or the rest of it
// (Meta's summary as is, open weights' raw thinking in a scrolling box).
// No labels; the row's place in the run says what it is. The newest one
// stays open while the run is live, to follow along; once someone toggles a
// row, it's theirs.
function ThoughtRow({
  thought,
  lane,
  offsetMs,
  live,
  running,
}: {
  thought: Thought;
  lane?: ReactNode;
  offsetMs: number;
  live: boolean;
  running: boolean;
}) {
  const [toggled, setToggled] = useState<boolean>();
  const thinking = thought.durationMs === undefined;
  const open = toggled ?? (live && !thinking);
  const raw = thought.reasoningKind === "raw";
  // Without a note, the reasoning gives the headline: a summary's first line,
  // or raw thinking's last, where open weights decide what to do next ("Check
  // deploy history around 19:02.") after recapping the results above it.
  const lines = (thought.reasoning ?? "").split("\n");
  const nonEmpty = lines.flatMap((l, i) => (l.trim() ? [i] : []));
  const pick = raw ? nonEmpty.at(-1) : nonEmpty[0];
  const headline = thought.text ?? (pick === undefined ? "" : lines[pick].trim());
  // What the open row adds: the reasoning, or the rest of it, in order.
  const rest = thought.text
    ? thought.reasoning
    : lines.filter((_, i) => i !== pick).join("\n").trim() || undefined;
  return (
    <li className={cn(running && enterMotion)}>
      <Collapsible open={open} onOpenChange={setToggled} className="rounded-md">
        <CollapsibleTrigger
          disabled={thinking}
          className="grid w-full grid-cols-[auto_7rem_minmax(0,1fr)_auto] items-start gap-x-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/50 disabled:hover:bg-transparent"
        >
          {/* Tinted, unlike the tool icons, and with the text across the
              tool-name column too: the model talking, not a call. */}
          <BrainIcon
            aria-label={thinking ? "Thinking" : "Thought"}
            className={cn("mt-[3px] size-3.5 text-brand", thinking && "animate-pulse motion-reduce:animate-none")}
          />
          <span
            className={cn(
              "col-span-2",
              open ? "whitespace-pre-wrap" : "truncate",
              thinking ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {thinking ? "Thinking…" : headline}
          </span>
          <span className="mt-0.5 flex items-baseline gap-2 font-mono text-muted-foreground text-xs tabular-nums">
            {lane}
            <span className="w-14 text-right opacity-70">{thinking ? "…" : formatDuration(thought.durationMs!)}</span>
            <span className={cn(lane && "max-sm:hidden")}>{formatOffset(offsetMs)}</span>
          </span>
        </CollapsibleTrigger>
        {rest && (
          <CollapsibleContent>
            <p
              className={cn(
                "mb-2 ml-8 whitespace-pre-wrap border-l pl-3 text-muted-foreground text-xs",
                // Raw thinking runs long; it scrolls rather than pushing the
                // tool calls off the page.
                raw && "max-h-72 overflow-y-auto font-mono text-[11px]",
              )}
            >
              {rest}
            </p>
          </CollapsibleContent>
        )}
      </Collapsible>
    </li>
  );
}

// A few choices as one small pill, in the timeline's header: the view, and
// which evidence the phases show.
function PillToggle<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; count?: number }[];
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-md bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex h-6 items-center gap-1.5 rounded-[5px] px-2 transition-colors",
            value === o.value ? "bg-background text-foreground shadow-sm" : "hover:text-foreground",
          )}
        >
          {o.label}
          {o.count !== undefined && <span className="tabular-nums opacity-60">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

// The spinner, then the tool's icon (or a cross) that pops in when the step
// finishes while in view. Steps already done when the row mounts show it
// still.
function StepStatusIcon({ status, tool }: { status: InvestigationStep["status"]; tool: ToolName }) {
  const justFinished = useChangedSinceMount(status);
  const { Icon, className } =
    status === "completed" ? { Icon: toolIcons[tool] ?? FileCodeIcon, className: "text-muted-foreground" } : statusIcons[status];
  return (
    <Icon
      className={cn(
        "size-3.5",
        className,
        justFinished && "animate-in fade-in-0 zoom-in-50 duration-200 ease-out motion-reduce:animate-none",
      )}
    />
  );
}

// Marks case-insensitive matches of the search query.
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return text;
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded-sm bg-warning/25 text-foreground">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

// Time since the first step, to the millisecond as recorded: "0:03.412".
function formatOffset(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const s = Math.floor(total / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}.${String(total % 1000).padStart(3, "0")}`;
}

// "23:30:05.412", for the hover title.
function formatTimeMs(iso: string): string {
  return `${formatTime(iso)}.${String(new Date(iso).getUTCMilliseconds()).padStart(3, "0")}`;
}
