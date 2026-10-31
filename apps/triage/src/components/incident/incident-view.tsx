"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";
import { markSeen, recordView } from "@/hooks/use-seen";
import { findUnknownEvidenceIds, type Incident } from "@/lib/investigation/schema";
import { activityAt } from "@/lib/investigation/summary";
import { citationOrder } from "./diagnosis-panel";
import { EvidenceProvider } from "./evidence";
import { IncidentCommands } from "./incident-commands";
import { IncidentProvider } from "./incident-export";
import { IncidentHeader } from "./incident-header";
import { IncidentReport } from "./incident-report";
import { useAskQuestion } from "./questions-panel";

// While the agent works, re-render from the server every couple of seconds;
// it saves each step as it goes. Every second while a question is being
// answered: its answer is saved as it streams, so a second tab (or this
// one after a reload) reads along.
function useRefreshWhile(active: boolean, intervalMs = 2000) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, router]);
}

// A summary header with the facts that matter, then the report: a section
// menu beside one section at a time.
export function IncidentView({ incident }: { incident: Incident }) {
  const { report } = incident;
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
  useRefreshWhile(
    incident.status === "investigating" ||
      fixing ||
      mitigating ||
      incident.approval?.prState === "opening" ||
      answering ||
      writingPostmortem ||
      verifying,
    answering ? 1000 : 2000,
  );
  // This tab's own question streams here, above the sections, so switching
  // sections mid-answer keeps the stream.
  const ask = useAskQuestion(incident);
  // Whatever happened up to now has been seen; a run that finishes while
  // this page is open is seen as the refresh brings it in.
  const latest = activityAt(incident);
  useEffect(() => markSeen(incident.id, latest), [incident.id, latest]);
  useEffect(() => recordView(incident.id), [incident.id]);
  const unknownEvidenceIds = useMemo(
    () => (report ? findUnknownEvidenceIds(report, incident.evidence) : []),
    [report, incident.evidence],
  );
  const order = useMemo(() => (report ? citationOrder(report) : []), [report]);
  // A chip in an answer opens the same panel as one in the report: the
  // investigation's evidence, then each question's, in the order asked.
  const evidence = useMemo(
    () => [...incident.evidence, ...(incident.questions ?? []).flatMap((q) => q.evidence)],
    [incident.evidence, incident.questions],
  );

  return (
    <IncidentProvider incident={incident}>
      <EvidenceProvider evidence={evidence} order={order}>
        <IncidentCommands incident={incident} />
        <IncidentHeader incident={incident} />
        {/* A container, so the report lays out by its own width. */}
        <div className="@container mx-auto w-full max-w-6xl px-4 pt-5 pb-8 sm:px-6">
          <IncidentReport incident={incident} unknownEvidenceIds={unknownEvidenceIds} cited={order} ask={ask} />
        </div>
      </EvidenceProvider>
    </IncidentProvider>
  );
}
