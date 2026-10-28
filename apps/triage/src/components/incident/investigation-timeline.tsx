"use client";

import {
  ChevronRightIcon,
  CircleCheckIcon,
  CircleXIcon,
  LoaderCircleIcon,
  SearchIcon,
  SearchXIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useChangedSinceMount } from "@/hooks/use-changed-since-mount";
import { useCountUp } from "@/hooks/use-count-up";
import type { InvestigationStep, Run, ToolName } from "@/lib/investigation/schema";
import { cn } from "@/lib/utils";
import { Citations, evidenceIcons, useEvidence } from "./evidence";
import { modelLabel } from "@/lib/models/labels";
import { formatDuration, formatTime } from "./format";
import { evidenceTitle } from "./metric-labels";
import { activeFilterCount, emptyFilters, type Filters, filterSteps, matchSnippet } from "./log-filters";
import { LogToolbar } from "./log-toolbar";

const statusIcons = {
  running: { Icon: LoaderCircleIcon, className: "animate-spin text-muted-foreground" },
  completed: { Icon: CircleCheckIcon, className: "text-muted-foreground" },
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

// The phases an investigation moves through, by the tool used.
type Phase = "metrics" | "logs" | "database" | "changes" | "code";

const phaseOf: Record<ToolName, Phase> = {
  query_metrics: "metrics",
  query_logs: "logs",
  query_traces: "logs",
  db_diagnostics: "database",
  deploy_history: "changes",
  git_log: "changes",
  read_source: "code",
};

const phaseLabels: Record<Phase, string> = {
  metrics: "Metrics",
  logs: "Logs and traces",
  database: "Database",
  changes: "What changed",
  code: "Code",
};

interface PhaseGroup {
  phase: Phase;
  steps: InvestigationStep[];
}

// Phases in the order the agent first reached them.
function groupByPhase(steps: InvestigationStep[]): PhaseGroup[] {
  const groups = new Map<Phase, InvestigationStep[]>();
  for (const step of steps) {
    const phase = phaseOf[step.tool];
    groups.set(phase, [...(groups.get(phase) ?? []), step]);
  }
  return [...groups].map(([phase, groupSteps]) => ({ phase, steps: groupSteps }));
}

// The investigation as one timeline grouped by phase: the Investigation
// section of the report. Each phase leads with its evidence, numbered like
// the citations: just what the diagnosis cites, or all of it. Its tool calls
// fold below. While the agent runs, or while searching or filtering, the
// tool calls show directly.
export function InvestigationTimeline({
  steps,
  cited,
  running,
  run,
}: {
  steps: InvestigationStep[];
  cited: string[];
  running: boolean;
  run?: Run;
}) {
  const { byId, numberOf, open, focused, covered } = useEvidence();
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
  const t0 = steps.length ? Date.parse(steps[0].startedAt) : 0;
  const showCallsByDefault = filtering || running || cited.length === 0;
  const took = run?.finishedAt ? formatDuration(Date.parse(run.finishedAt) - Date.parse(run.startedAt)) : undefined;
  // Ticks up as the agent adds calls, rather than jumping.
  const callCount = Math.round(useCountUp(steps.length, { duration: 400 }));

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
      const phase = phaseOf[step.tool];
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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <span className="tabular-nums">
          {took && `${took} · `}
          {callCount} tool {callCount === 1 ? "call" : "calls"}
          {run && ` · ${modelLabel(run.model, run.provider)}`}
        </span>
        {cited.length > 0 && (
          <div role="group" aria-label="Evidence shown" className="ml-auto inline-flex rounded-md bg-muted p-0.5">
            {[
              { all: false, label: "Cited", count: cited.length },
              { all: true, label: "All evidence", count: byId.size },
            ].map((o) => (
              <button
                key={o.label}
                type="button"
                aria-pressed={showAll === o.all}
                onClick={() => setShowAll(o.all)}
                className={cn(
                  "flex h-6 items-center gap-1.5 rounded-[5px] px-2 transition-colors",
                  showAll === o.all ? "bg-background text-foreground shadow-sm" : "hover:text-foreground",
                )}
              >
                {o.label}
                <span className="tabular-nums opacity-60">{o.count}</span>
              </button>
            ))}
          </div>
        )}
        <Button
          variant={searchOpen || filtering ? "secondary" : "ghost"}
          size="icon-xs"
          aria-label="Search and filter tool calls"
          aria-pressed={searchOpen || filtering}
          onClick={toggleSearch}
          className={cn(cited.length === 0 && "ml-auto")}
        >
          <SearchIcon />
        </Button>
      </div>
      <div ref={rootRef} className="flex flex-col gap-3">
        {(searchOpen || filtering) && (
          <LogToolbar
            steps={steps}
            query={query}
            onQueryChange={setQuery}
            filters={filters}
            onFiltersChange={setFilters}
            shown={shown.length}
            inputRef={inputRef}
          />
        )}

        {groups.length === 0 ? (
          // Held back a beat, so it doesn't flash while a query is still being typed.
          <div className="flex flex-col items-center gap-1 rounded-md border border-dashed py-6 text-center animate-in fade-in-0 delay-150 fill-mode-backwards duration-200 ease-out motion-reduce:animate-none">
            <SearchXIcon className="mb-1 size-5 text-muted-foreground" />
            <p className="font-medium text-sm">No tool calls match</p>
            <p className="text-muted-foreground text-xs">Try a different search or remove a filter.</p>
            <Button variant="outline" size="sm" onClick={clearAll} className="mt-2">
              Clear search and filters
            </Button>
          </div>
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
    </div>
  );
}

function StepRow({
  step,
  offsetMs,
  query,
  snippet,
  highlighted,
  running,
}: {
  step: InvestigationStep;
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
          <StepStatusIcon status={step.status} />
          <span className="font-mono text-xs">
            <Highlight text={step.tool} query={query} />
          </span>
          <span className="truncate text-muted-foreground">
            <Highlight text={step.error ?? step.summary ?? "Running..."} query={query} />
          </span>
          {/* How long the call took, then when it started, to the
              millisecond. The absolute start time is on hover. */}
          <span
            className="flex items-baseline gap-2 font-mono text-muted-foreground text-xs tabular-nums"
            title={`Started ${formatTimeMs(step.startedAt)} UTC${step.durationMs !== undefined ? `, took ${formatDuration(step.durationMs)}` : ""}`}
          >
            <span className="w-14 text-right opacity-70">
              {step.durationMs !== undefined ? formatDuration(step.durationMs) : step.status === "running" ? "…" : ""}
            </span>
            <span>{formatOffset(offsetMs)}</span>
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

// The spinner, then a check or cross that pops in when the step finishes
// while in view. Steps already done when the row mounts show it still.
function StepStatusIcon({ status }: { status: InvestigationStep["status"] }) {
  const justFinished = useChangedSinceMount(status);
  const { Icon, className } = statusIcons[status];
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
