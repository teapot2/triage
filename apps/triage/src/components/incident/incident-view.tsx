"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";
import { markSeen, recordView } from "@/hooks/use-seen";
import { findUnknownEvidenceIds, type Incident } from "@/lib/investigation/schema";
import { activityAt } from "@/lib/investigation/summary";
import { citationOrder } from "./diagnosis-panel";
import { EvidenceProvider } from "./evidence";
import { IncidentCommands } from "./incident-commands";
import { IncidentHeader } from "./incident-header";
import { IncidentReport } from "./incident-report";

// While the agent works, re-render from the server every couple of seconds;
// it saves each step as it goes.
function useRefreshWhile(active: boolean) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(timer);
  }, [active, router]);
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
  useRefreshWhile(incident.status === "investigating" || fixing || mitigating || incident.approval?.prState === "opening");
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

  return (
    <EvidenceProvider evidence={incident.evidence} order={order}>
      <IncidentCommands incident={incident} />
      <IncidentHeader incident={incident} />
      {/* A container, so the report lays out by its own width. */}
      <div className="@container mx-auto w-full max-w-6xl px-4 pt-8 pb-8 sm:px-6">
        <IncidentReport incident={incident} unknownEvidenceIds={unknownEvidenceIds} cited={order} />
      </div>
    </EvidenceProvider>
  );
}
