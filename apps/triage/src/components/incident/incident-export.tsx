"use client";

import { type ComponentProps, createContext, type ReactNode, useContext, useMemo } from "react";
import type { ExportSource } from "@/components/export-menu";
import {
  askAnswers,
  dbRows,
  evidenceDb,
  evidenceLogs,
  evidenceMetrics,
  evidenceSource,
  evidenceSpans,
  incidentRecord,
  incidentSubject,
  investigationTrace,
  logRows,
  metricRows,
  sourceRows,
  spanRows,
  traceRows,
} from "@/lib/export/datasets/incident";
import type { Incident } from "@/lib/investigation/schema";
import { MetricChart } from "./metric-chart";

export { incidentSubject };

// The incident a page is about, for what sits outside the report (the
// evidence panel) or deep inside it, to name and fetch its exports.
const IncidentContext = createContext<Pick<Incident, "id" | "title"> | undefined>(undefined);

export function IncidentProvider({ incident, children }: { incident: Pick<Incident, "id" | "title">; children: ReactNode }) {
  const { id, title } = incident;
  // The page refreshes the incident every second or two while it runs: the
  // same id and title don't re-render what reads them.
  const value = useMemo(() => ({ id, title }), [id, title]);
  return <IncidentContext.Provider value={value}>{children}</IncidentContext.Provider>;
}

export const useIncident = () => useContext(IncidentContext);

// The header's Export menu: the record, then the raw evidence by kind and
// the investigation's trace, each only when the incident has some.
export function incidentExports(incident: Incident): ExportSource[] {
  const params = { id: incident.id };
  const offered: [ExportSource["dataset"], boolean][] = [
    [incidentRecord, true],
    [evidenceLogs, logRows(incident).length > 0],
    [evidenceSpans, spanRows(incident).length > 0],
    [evidenceMetrics, metricRows(incident).length > 0],
    [evidenceDb, dbRows(incident).length > 0],
    // The code read; on a dependency incident, the files the exposure cites.
    [evidenceSource, sourceRows(incident).length > 0],
    [investigationTrace, traceRows(incident).length > 0],
    // The Ask thread, once something in it is answered.
    [askAnswers, incident.questions?.some((q) => q.status === "answered") ?? false],
  ];
  return offered.flatMap(([dataset, any]) => (any ? [{ dataset, params }] : []));
}

// A chart in the evidence panel, its data downloadable as the incident's.
// The panel sits beside the report, not inside it; the page's incident
// names it. The metric leads the name, so it survives the filename's cut
// and two charts' files from one incident don't read alike. Off an
// incident's page, plain.
export function EvidenceMetricChart(props: Omit<ComponentProps<typeof MetricChart>, "exportAs">) {
  const incident = useIncident();
  const subject = incident && { kind: "incident", id: incident.id, name: `${props.label}, ${incident.title}` };
  return <MetricChart {...props} exportAs={subject && { subject }} />;
}
