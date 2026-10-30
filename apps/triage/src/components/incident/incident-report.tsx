"use client";

import {
  ArrowRightIcon,
  ChartLineIcon,
  FileTextIcon,
  LayoutListIcon,
  LoaderCircleIcon,
  type LucideIcon,
  MessageSquareTextIcon,
  RouteIcon,
  WrenchIcon,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ChartPoint, Incident } from "@/lib/investigation/schema";
import { providerLabels } from "@/lib/models/labels";
import { cn } from "@/lib/utils";
import { citedDeploys, VerdictCard } from "./diagnosis-panel";
import { FailedRunNotice } from "./failed-run-notice";
import { AttemptBadge, EarlierAttempts, FixProgress, FixProof, FixView } from "./fix-panel";
import { InvestigationTimeline } from "./investigation-timeline";
import { type ChartMarker, MetricChart } from "./metric-chart";
import { metricLabel } from "./metric-labels";
import { MitigationCard, mitigationMarker } from "./mitigation-card";
import { MetricBadges } from "./outcome-badges";
import { hasPostmortem, PostmortemPanel } from "./postmortem-panel";
import { type Ask, QuestionsPanel } from "./questions-panel";
import { ReopenedNotice, reopening, VerificationCard } from "./verification";

type SectionId = "overview" | "fix" | "investigation" | "questions" | "postmortem";

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
  ask,
}: {
  incident: Incident;
  unknownEvidenceIds: string[];
  cited: string[];
  ask: Ask;
}) {
  const { report, fix, validation, steps, evidence, trigger, run, mitigation, fixAttempts, verification } = incident;
  const running = incident.status === "investigating";
  const reopened = reopening(incident);
  const markers = [
    ...(report ? citedDeploys(report, evidence) : []),
    mitigationMarker(mitigation),
    ...resolutionMarkers(incident),
  ].filter((m) => m !== undefined);

  // A verdict that arrives while the page is open rises in, the fix just
  // after it; one that was already there when the incident opened just
  // shows. Tracked per incident, in case the view is reused for another.
  const [opened, setOpened] = useState({ id: incident.id, hadReport: report !== undefined });
  if (opened.id !== incident.id) setOpened({ id: incident.id, hadReport: report !== undefined });
  const arrived = report !== undefined && !opened.hadReport;
  const arrive = arrived && "animate-in fade-in-0 slide-in-from-bottom-2 duration-300 ease-out motion-reduce:animate-none";

  const sections: ReportSection[] = [{ id: "overview", label: "Overview", icon: LayoutListIcon }];
  // Also while a new attempt is written after a deny: the denied ones stay.
  if (fix || fixAttempts?.length) sections.push({ id: "fix", label: "Fix", icon: WrenchIcon });
  if (steps.length > 0) {
    sections.push({ id: "investigation", label: "Investigation", icon: RouteIcon, count: steps.length });
  }
  // Questions open once there's a report to ask about. The count is the
  // questions asked, this tab's in-flight one included (it's saved on the
  // incident a beat later).
  const savedQuestions = incident.questions ?? [];
  const answering = savedQuestions.some((q) => q.status === "answering") || ask.live !== undefined;
  if (report) {
    const extra = ask.live && !savedQuestions.some((q) => q.id === ask.live?.id) ? 1 : 0;
    sections.push({ id: "questions", label: "Ask", icon: MessageSquareTextIcon, count: savedQuestions.length + extra });
  }
  // The postmortem, once a report names something wrong.
  const postmortem = incident.postmortem;
  if (hasPostmortem(incident)) sections.push({ id: "postmortem", label: "Postmortem", icon: FileTextIcon });
  const factors = postmortem?.status === "ready" ? (postmortem.contributingFactors?.length ?? 0) : 0;

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
        {reopened && <ReopenedNotice incident={incident} reopening={reopened} />}
        {report ? (
          <VerdictCard
            report={report}
            unknownEvidenceIds={unknownEvidenceIds}
            className={arrive || undefined}
          />
        ) : (
          running && (
            <div className="flex flex-col items-start gap-2">
              <p className="flex items-center gap-2 text-muted-foreground text-sm">
                <LoaderCircleIcon className="size-4 animate-spin" />
                {run?.wakingSince
                  ? `Starting the ${providerLabels[run.provider ?? ""] ?? "model's"} deployment. After it scales to zero, its first start takes a few minutes; the investigation begins once it answers.`
                  : "Investigating. The verdict appears once the report passes validation."}
              </p>
              <Button variant="outline" size="sm" onClick={() => setSelected("investigation")}>
                Watch the investigation <ArrowRightIcon />
              </Button>
            </div>
          )
        )}

        {factors > 0 && (
          <button
            type="button"
            onClick={() => setSelected("postmortem")}
            className="-mt-6 flex items-center gap-1.5 self-start text-muted-foreground text-xs transition-colors hover:text-foreground"
          >
            <FileTextIcon className="size-3.5" />
            {factors} contributing {factors === 1 ? "factor" : "factors"} in the postmortem
            <ArrowRightIcon className="size-3.5" />
          </button>
        )}

        {mitigation && (
          <MitigationCard incident={incident} className={cn(arrive && [arrive, "delay-75 fill-mode-backwards"])} />
        )}

        {/* Without an applied mitigation to sit under (after a merged fix,
            or one asked for by hand), the verification gets its own card. */}
        {verification && mitigation?.state !== "applied" && (
          <VerificationCard incident={incident} verification={verification} />
        )}

        {!fix && incident.fixRun && <FixProgress fixRun={incident.fixRun} attempts={fixAttempts} />}

        {fix && (
          <div className={cn("flex flex-col gap-2 rounded-lg border p-4", arrive && [arrive, "delay-150 fill-mode-backwards"])}>
            <span className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
              <WrenchIcon className="size-3.5" />
              Proposed fix · {fix.risk} risk
              <AttemptBadge attempts={fixAttempts} />
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
            <MetricBadges observed={trigger.observed} threshold={trigger.threshold} unit={trigger.unit} />
          </div>
          <MetricChart
            series={chartSeries(incident, markers)}
            label={metricLabel(trigger.metric)}
            unit={trigger.unit}
            threshold={trigger.threshold}
            markers={markers}
          />
        </div>
      </div>
    ),
    fix: () =>
      fix ? (
        <FixView fix={fix} validation={validation} fixRun={incident.fixRun} attempts={fixAttempts} />
      ) : (
        <div className="flex flex-col gap-4">
          {incident.fixRun && <FixProgress fixRun={incident.fixRun} attempts={fixAttempts} />}
          <EarlierAttempts attempts={fixAttempts} />
        </div>
      ),
    investigation: () => (
      <InvestigationTimeline steps={steps} thoughts={incident.thoughts} cited={cited} running={running} run={run} />
    ),
    questions: () => <QuestionsPanel incident={incident} ask={ask} />,
    postmortem: () => <PostmortemPanel incident={incident} />,
  };

  return (
    // The menu sits beside the section only while the report itself is wide
    // enough (a container query, not the window): the docked evidence panel
    // takes room, and then the menu becomes a row on top.
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 @2xl:grid-cols-[11rem_minmax(0,1fr)] @2xl:gap-10">
      <nav aria-label="Report sections" className="@2xl:sticky @2xl:top-18 @2xl:self-start">
        <ul className="-mx-1 flex gap-1 overflow-x-auto pb-1 @2xl:mx-0 @2xl:flex-col @2xl:overflow-visible @2xl:pb-0">
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
                  {(s.id === "investigation" && running) ||
                  (s.id === "questions" && answering) ||
                  (s.id === "postmortem" && postmortem?.status === "writing") ? (
                    <LoaderCircleIcon className="size-4 animate-spin" />
                  ) : (
                    <Icon className="size-4" />
                  )}
                  {s.label}
                  {/* None yet says nothing worth a "0". */}
                  {s.count ? (
                    <span className="ml-auto pl-2 font-mono text-muted-foreground text-xs tabular-nums">{s.count}</span>
                  ) : null}
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

// Each resolution and reopening on the alert chart: the current resolution
// and the ones a reopening undid, then every reopening.
function resolutionMarkers(incident: Incident): ChartMarker[] {
  const reopenings = incident.reopenings ?? [];
  const resolved = new Set(reopenings.flatMap((r) => (r.resolvedAt ? [r.resolvedAt] : [])));
  if (incident.resolvedAt) resolved.add(incident.resolvedAt);
  return [
    ...[...resolved].map((t): ChartMarker => ({ t, label: "resolved", tone: "success" })),
    ...reopenings.map((r): ChartMarker => ({ t: r.at, label: "reopened", tone: "warning" })),
  ];
}

// How far past the last point a marker may stretch the chart: a reopening
// by hand comes after the verification's last minute. Further than this the
// chart's scale would say nothing, and the notice says it instead.
const STRETCH_MS = 30 * 60_000;

// The alert's metric as far as it was watched: the alert's series, the
// recovery watch's, then the verification's, one point per time. Empty
// minutes stretch it to a marker shortly after its last point.
function chartSeries(incident: Incident, markers: ChartMarker[]): ChartPoint[] {
  const byTime = new Map<string, ChartPoint>();
  for (const p of [
    ...incident.trigger.series,
    ...(incident.mitigation?.recovery?.series ?? []),
    ...(incident.verification?.series ?? []),
  ]) {
    if (!byTime.has(p.t)) byTime.set(p.t, p);
  }
  const series: ChartPoint[] = [...byTime.values()].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  if (series.length < 2) return series;
  const end = Date.parse(series[series.length - 1].t);
  const step = end - Date.parse(series[series.length - 2].t) || 60_000;
  const reach = Math.max(
    end,
    ...markers.map((m) => Date.parse(m.t)).filter((t) => t > end && t - end <= STRETCH_MS),
  );
  for (let t = end + step; t - step < reach; t += step) series.push({ t: new Date(t).toISOString(), value: null });
  return series;
}
