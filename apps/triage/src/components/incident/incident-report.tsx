"use client";

import {
  ArrowRightIcon,
  ChartLineIcon,
  LayoutListIcon,
  LoaderCircleIcon,
  type LucideIcon,
  RouteIcon,
  WrenchIcon,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Incident } from "@/lib/investigation/schema";
import { cn } from "@/lib/utils";
import { citedDeploys, VerdictCard } from "./diagnosis-panel";
import { FailedRunNotice } from "./failed-run-notice";
import { FixProgress, FixProof, FixView } from "./fix-panel";
import { InvestigationTimeline } from "./investigation-timeline";
import { MetricChart } from "./metric-chart";
import { metricLabel } from "./metric-labels";

type SectionId = "overview" | "fix" | "investigation";

interface ReportSection {
  id: SectionId;
  label: string;
  icon: LucideIcon;
  count?: number;
}

// The report's sections in a menu beside the content, one section shown at a
// time (like a settings or docs page). Overview is the answer, with its
// reasoning folded under it; Fix and Investigation are the details.
export function IncidentReport({
  incident,
  unknownEvidenceIds,
  cited,
}: {
  incident: Incident;
  unknownEvidenceIds: string[];
  cited: string[];
}) {
  const { report, fix, validation, steps, evidence, trigger, run } = incident;
  const running = incident.status === "investigating";
  const breached = trigger.observed > trigger.threshold;

  // A verdict that arrives while the page is open rises in, the fix just
  // after it; one that was already there when the incident opened just
  // shows. Tracked per incident, in case the view is reused for another.
  const [opened, setOpened] = useState({ id: incident.id, hadReport: report !== undefined });
  if (opened.id !== incident.id) setOpened({ id: incident.id, hadReport: report !== undefined });
  const arrived = report !== undefined && !opened.hadReport;
  const arrive = arrived && "animate-in fade-in-0 slide-in-from-bottom-2 duration-300 ease-out motion-reduce:animate-none";

  const sections: ReportSection[] = [{ id: "overview", label: "Overview", icon: LayoutListIcon }];
  if (fix) sections.push({ id: "fix", label: "Fix", icon: WrenchIcon });
  if (steps.length > 0) {
    sections.push({ id: "investigation", label: "Investigation", icon: RouteIcon, count: steps.length });
  }

  // The open section lives in the URL (?section=fix), so it can be linked
  // to, survives a refresh, and the back button steps through it. Without
  // one: while the agent runs there's no verdict yet, so its live log.
  const searchParams = useSearchParams();
  const fallback: SectionId = running ? "investigation" : "overview";
  const current =
    sections.find((s) => s.id === searchParams.get("section")) ??
    sections.find((s) => s.id === fallback) ??
    sections[0];
  const setSelected = (id: SectionId) => {
    if (id === current.id) return;
    const params = new URLSearchParams(searchParams.toString());
    if (id === fallback) params.delete("section");
    else params.set("section", id);
    const query = params.toString();
    window.history.pushState(null, "", query ? `?${query}` : window.location.pathname);
  };

  const content: Record<SectionId, () => ReactNode> = {
    overview: () => (
      <div className="flex flex-col gap-8">
        {incident.status === "failed" && run?.error && <FailedRunNotice run={{ ...run, error: run.error }} />}
        {report ? (
          <VerdictCard report={report} unknownEvidenceIds={unknownEvidenceIds} className={arrive || undefined} />
        ) : (
          running && (
            <div className="flex flex-col items-start gap-2">
              <p className="flex items-center gap-2 text-muted-foreground text-sm">
                <LoaderCircleIcon className="size-4 animate-spin" />
                Investigating. The verdict appears once the report passes validation.
              </p>
              <Button variant="outline" size="sm" onClick={() => setSelected("investigation")}>
                Watch the investigation <ArrowRightIcon />
              </Button>
            </div>
          )
        )}

        {!fix && incident.fixRun && <FixProgress fixRun={incident.fixRun} />}

        {fix && (
          <div className={cn("flex flex-col gap-2 rounded-lg border p-4", arrive && [arrive, "delay-75 fill-mode-backwards"])}>
            <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
              <WrenchIcon className="size-3.5" />
              Proposed fix · {fix.risk} risk
            </span>
            <p className="text-sm leading-relaxed">{fix.summary}</p>
            <FixProof validation={validation} />
            <Button variant="outline" size="sm" className="mt-1 self-start" onClick={() => setSelected("fix")}>
              Review the fix <ArrowRightIcon />
            </Button>
          </div>
        )}

        {/* The alert, as a card like the verdict and fix above it: what fired
            on the left, how far past its limit on the right. */}
        <div className="flex flex-col gap-3 rounded-lg border p-4">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <ChartLineIcon className="size-3.5" />
              {metricLabel(trigger.metric)}
            </span>
            <span className="text-muted-foreground tabular-nums">
              <span className={cn("font-medium", breached ? "text-destructive" : "text-foreground")}>
                {Math.round(trigger.observed)} {trigger.unit}
              </span>{" "}
              · limit {trigger.threshold} {trigger.unit}
            </span>
          </div>
          <MetricChart
            series={trigger.series}
            label={metricLabel(trigger.metric)}
            unit={trigger.unit}
            threshold={trigger.threshold}
            markers={report ? citedDeploys(report, evidence) : []}
          />
        </div>
      </div>
    ),
    fix: () => fix && <FixView fix={fix} validation={validation} fixRun={incident.fixRun} />,
    investigation: () => <InvestigationTimeline steps={steps} cited={cited} running={running} run={run} />,
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 md:grid-cols-[11rem_minmax(0,1fr)] md:gap-10">
      <nav aria-label="Report sections" className="md:sticky md:top-18 md:self-start">
        <ul className="-mx-1 flex gap-1 overflow-x-auto pb-1 md:mx-0 md:flex-col md:overflow-visible md:pb-0">
          {sections.map((s) => {
            const Icon = s.icon;
            const active = s.id === current.id;
            return (
              <li key={s.id} className="shrink-0">
                <button
                  type="button"
                  onClick={() => setSelected(s.id)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors",
                    active
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                >
                  {s.id === "investigation" && running ? (
                    <LoaderCircleIcon className="size-4 animate-spin" />
                  ) : (
                    <Icon className="size-4" />
                  )}
                  {s.label}
                  {s.count !== undefined && (
                    <span className="ml-auto pl-2 font-mono text-muted-foreground text-xs tabular-nums">{s.count}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <section key={current.id} className="flex flex-col gap-5 fade-in-0 slide-in-from-bottom-1 animate-in duration-200 ease-out motion-reduce:animate-none">
        {/* The menu's highlight already names the section on screen; the
            heading stays for screen readers, who move between sections by it. */}
        <h2 className="sr-only">{current.label}</h2>
        {content[current.id]()}
      </section>
    </div>
  );
}
