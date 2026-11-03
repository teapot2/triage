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
import { SectionMenu, selectSection } from "@/components/section-menu";
import { Button } from "@/components/ui/button";
import { isArchived } from "@/lib/investigation/archive";
import { dataChangeOf } from "@/lib/investigation/fix/data-change";
import type { Incident } from "@/lib/investigation/schema";
import { providerLabels } from "@/lib/models/labels";
import { cn } from "@/lib/utils";
import { chartSeries } from "./chart-series";
import { citedDeploys, VerdictCard } from "./diagnosis-panel";
import { DependencyOverview } from "./dependency-overview";
import { EndpointCard } from "./endpoint-card";
import { FailedRunNotice } from "./failed-run-notice";
import { AttemptBadge, BumpLine, EarlierAttempts, FixProgress, FixProof, FixView } from "./fix-panel";
import { HypothesesChecked } from "./hypotheses-checked";
import { incidentSubject } from "./incident-export";
import { InvestigationTimeline } from "./investigation-timeline";
import { type ChartMarker, MetricChart } from "./metric-chart";
import { lowerIsWorse, metricLabel } from "./metric-labels";
import { MitigationCard, mitigationMarker, NoMitigationCard } from "./mitigation-card";
import { MetricBadges } from "./outcome-badges";
import { hasPostmortem, PostmortemPanel } from "./postmortem-panel";
import { type Ask, QuestionsPanel } from "./questions-panel";
import { ReopenedNotice, reopening, VerificationCard } from "./verification";

type SectionId = "overview" | "fix" | "investigation" | "ask" | "postmortem";

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
  readOnly = false,
}: {
  incident: Incident;
  unknownEvidenceIds: string[];
  cited: string[];
  ask: Ask;
  // Another of the incident's runs than its own: nothing on it can be acted
  // on, and the incident's questions and postmortem aren't its.
  readOnly?: boolean;
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
  // Archived, Ask and Postmortem show only what's already there.
  const archived = isArchived(incident);
  if (report && !readOnly && (!archived || savedQuestions.length > 0)) {
    const extra = ask.live && !savedQuestions.some((q) => q.id === ask.live?.id) ? 1 : 0;
    sections.push({ id: "ask", label: "Ask", icon: MessageSquareTextIcon, count: savedQuestions.length + extra });
  }
  // The postmortem, once a report names something wrong.
  const postmortem = incident.postmortem;
  if (hasPostmortem(incident) && !readOnly && (!archived || postmortem)) sections.push({ id: "postmortem", label: "Postmortem", icon: FileTextIcon });
  const factors = postmortem?.status === "ready" ? (postmortem.contributingFactors?.length ?? 0) : 0;

  // The open section lives in the URL (?section=fix), so it can be linked
  // to, survives a refresh, and the back button steps through it. Without
  // one: while the agent runs there's no verdict yet, so its live log.
  const searchParams = useSearchParams();
  const fallback: SectionId = running ? "investigation" : "overview";
  // ?section=questions is Ask's old name, kept for links made before.
  const asked = searchParams.get("section");
  const current =
    sections.find((s) => s.id === (asked === "questions" ? "ask" : asked)) ??
    sections.find((s) => s.id === fallback) ??
    sections[0];
  const setSelected = (id: SectionId) => {
    if (id !== current.id) selectSection(searchParams, id, fallback);
  };
  // A spinner in place of the icon while that section is still working.
  const busy = (id: SectionId) =>
    (id === "investigation" && running) || (id === "ask" && answering) || (id === "postmortem" && postmortem?.status === "writing");

  // Every incident but a dependency one: the verdict, the mitigation, the
  // verification, the fix, then the alert. A dependency incident has its
  // own, shorter Overview (dependency-overview.tsx).
  const general = () => (
    <>
      {report ? (
        <VerdictCard
          incident={incident}
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

      {/* A fan-out run's hypotheses, under the verdict they were merged
          into, or being checked while it runs. */}
      {run?.fanout && (
        <HypothesesChecked fanout={run.fanout} lanes={run} running={running} className={cn(arrive && [arrive, "delay-75 fill-mode-backwards"])} />
      )}

      {mitigation && (
        <MitigationCard incident={incident} readOnly={readOnly} className={cn(arrive && [arrive, "delay-75 fill-mode-backwards"])} />
      )}
      {!mitigation && incident.noMitigation && (
        <NoMitigationCard why={incident.noMitigation.why} className={cn(arrive && [arrive, "delay-75 fill-mode-backwards"])} />
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
            Proposed fix · {fix.risk} risk{dataChangeOf(fix).detected && " · changes stored data"}
            <AttemptBadge attempts={fixAttempts} />
          </span>
          {fix.bump && <BumpLine bump={fix.bump} />}
          <p className="text-sm leading-relaxed">{fix.summary}</p>
          <FixProof validation={validation} bump={fix.bump !== undefined} />
          <Button variant="outline" size="sm" className="mt-1 self-start" onClick={() => setSelected("fix")}>
            Review the fix <ArrowRightIcon />
          </Button>
        </div>
      )}

      <EndpointCard incident={incident} />

      {/* The alert, as a card like the verdict and fix above it: what fired
          on the left, how far past its limit on the right. */}
      <div className="flex flex-col gap-3 rounded-lg border p-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <ChartLineIcon className="size-3.5" />
            {metricLabel(trigger.metric)}
          </span>
          <MetricBadges metric={trigger.metric} observed={trigger.observed} threshold={trigger.threshold} unit={trigger.unit} />
        </div>
        <MetricChart
          series={chartSeries(incident, markers)}
          label={metricLabel(trigger.metric)}
          unit={trigger.unit}
          threshold={trigger.threshold}
          lowerIsWorse={lowerIsWorse(trigger.metric)}
          markers={markers}
          exportAs={{ subject: incidentSubject(incident) }}
        />
      </div>
    </>
  );

  const content: Record<SectionId, () => ReactNode> = {
    overview: () => (
      <div className="flex flex-col gap-8">
        {incident.status === "failed" && run?.error && <FailedRunNotice run={{ ...run, error: run.error }} />}
        {reopened && <ReopenedNotice incident={incident} reopening={reopened} />}
        {incident.dependency ? (
          <DependencyOverview incident={incident} advisory={incident.dependency} unknownEvidenceIds={unknownEvidenceIds} onSection={setSelected} />
        ) : (
          general()
        )}
      </div>
    ),
    fix: () =>
      fix ? (
        <FixView fix={fix} validation={validation} fixRun={incident.fixRun} attempts={fixAttempts} />
      ) : (
        <div className="flex flex-col gap-4">
          {incident.fixRun && (
            <FixProgress fixRun={incident.fixRun} attempts={fixAttempts} dependency={incident.dependency !== undefined} />
          )}
          <EarlierAttempts attempts={fixAttempts} />
        </div>
      ),
    investigation: () => (
      <InvestigationTimeline steps={steps} thoughts={incident.thoughts} cited={cited} running={running} run={run} />
    ),
    ask: () => <QuestionsPanel incident={incident} ask={ask} />,
    postmortem: () => <PostmortemPanel incident={incident} />,
  };

  return (
    // The menu sits beside the section only while the report itself is wide
    // enough (a container query, not the window): the docked evidence panel
    // takes room, and then the menu becomes a row on top.
    <SectionMenu
      label="Report sections"
      sections={sections.map(({ icon: Icon, ...s }) => ({
        ...s,
        icon: busy(s.id) ? <LoaderCircleIcon className="animate-spin" /> : <Icon />,
      }))}
      current={current.id}
      onSelect={setSelected}
    >
      {content[current.id]()}
    </SectionMenu>
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
