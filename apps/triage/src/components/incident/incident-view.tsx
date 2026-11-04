"use client";

import { useEffect, useMemo } from "react";
import type { Choice } from "@/components/stage-choice-fields";
import { useRefreshWhile } from "@/hooks/use-refresh-while";
import { markSeen, recordView } from "@/hooks/use-seen";
import { findUnknownEvidenceIds, type Incident } from "@/lib/investigation/schema";
import { currentRun, isRunning, runView } from "@/lib/investigation/reruns";
import { activityAt } from "@/lib/investigation/summary";
import { ArchivedNotice } from "./archive-actions";
import { citationOrder } from "./diagnosis-panel";
import { EvidenceProvider } from "./evidence";
import { IncidentCommands } from "./incident-commands";
import { IncidentProvider } from "./incident-export";
import { IncidentHeader } from "./incident-header";
import { IncidentReport } from "./incident-report";
import { useAskQuestion } from "./questions-panel";
import { RunComparison, RunNotice, useShownRun } from "./run-switcher";

// A summary header with the facts that matter, then the report: a section
// menu beside one section at a time.
export function IncidentView({
  incident,
  askModel,
  webSearch,
  fullContext,
}: {
  incident: Incident;
  // Settings' Ask model, which the composer starts on.
  askModel?: Choice;
  webSearch?: boolean;
  fullContext?: boolean;
}) {
  // The run on screen: the incident's own, another of its runs (read only:
  // it acts on nothing until it's used), or all of them compared.
  const shown = useShownRun(incident);
  const view = (shown !== "compare" && runView(incident, shown)) || incident;
  const readOnly = shown !== "compare" && shown !== currentRun(incident);
  const { report } = view;
  // Also while the fix is being written and proven, after the verdict.
  const fixing = incident.fixRun?.status === "writing" || incident.fixRun?.status === "testing";
  // And while a mitigation runs and its recovery is watched.
  const mitigating =
    incident.mitigation?.state === "approved" ||
    incident.mitigation?.state === "running" ||
    incident.mitigation?.recovery?.status === "watching";
  const answering = incident.questions?.some((q) => q.status === "answering") ?? false;
  // And while the postmortem is written, and the fix is being verified.
  const writingPostmortem = incident.postmortem?.status === "writing";
  const verifying = incident.verification?.status === "verifying";
  // While the agent works, re-render from the server every couple of
  // seconds; it saves each step as it goes. Every second while a question
  // is being answered: its answer is saved as it streams, so a second tab
  // (or this one after a reload) reads along.
  useRefreshWhile(
    incident.status === "investigating" ||
      fixing ||
      mitigating ||
      incident.approval?.prState === "opening" ||
      answering ||
      writingPostmortem ||
      verifying ||
      (incident.reruns ?? []).some(isRunning),
    answering ? 1000 : 2000,
  );
  // This tab's own question streams here, above the sections, so switching
  // sections mid-answer keeps the stream.
  const ask = useAskQuestion(incident, askModel, webSearch, fullContext);
  // Whatever happened up to now has been seen; a run that finishes while
  // this page is open is seen as the refresh brings it in.
  const latest = activityAt(incident);
  useEffect(() => markSeen(incident.id, latest), [incident.id, latest]);
  useEffect(() => recordView(incident.id), [incident.id]);
  const unknownEvidenceIds = useMemo(
    () => (report ? findUnknownEvidenceIds(report, view.evidence) : []),
    [report, view.evidence],
  );
  const order = useMemo(() => (report ? citationOrder(report) : []), [report]);
  // A chip in an answer opens the same panel as one in the report: the
  // investigation's evidence, then each question's, in the order asked.
  const evidence = useMemo(
    () => [...view.evidence, ...(view.questions ?? []).flatMap((q) => q.evidence)],
    [view.evidence, view.questions],
  );

  return (
    <IncidentProvider incident={incident}>
      <EvidenceProvider evidence={evidence} order={order}>
        <IncidentCommands incident={incident} />
        <IncidentHeader incident={incident} view={view} shown={shown} />
        {/* A container, so the report lays out by its own width. */}
        <div className="@container mx-auto w-full max-w-6xl px-4 pt-5 pb-8 sm:px-6">
          <ArchivedNotice incident={incident} />
          <RunNotice incident={incident} shown={shown} />
          {shown === "compare" ? (
            <RunComparison incident={incident} />
          ) : (
            <IncidentReport incident={view} unknownEvidenceIds={unknownEvidenceIds} cited={order} ask={ask} readOnly={readOnly} />
          )}
        </div>
      </EvidenceProvider>
    </IncidentProvider>
  );
}
