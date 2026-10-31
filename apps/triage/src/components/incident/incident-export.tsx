"use client";

import { useParams } from "next/navigation";
import type { ComponentProps } from "react";
import type { ExportSubject } from "@/lib/export/dataset";
import type { Incident } from "@/lib/investigation/schema";
import { MetricChart } from "./metric-chart";

// What an incident's exports are about, for the file's name and JSON envelope.
export function incidentSubject(incident: Pick<Incident, "id" | "title">): ExportSubject {
  return { kind: "incident", id: incident.id, name: incident.title };
}

// A chart in the evidence panel, its data downloadable as the incident's.
// The panel sits beside the report, not inside it, so the incident isn't at
// hand; the page's route names it. The metric is in the name so two charts'
// files from one incident don't read alike. Off an incident's page, plain.
export function EvidenceMetricChart(props: Omit<ComponentProps<typeof MetricChart>, "exportAs">) {
  const { id } = useParams<{ id?: string }>();
  const subject = typeof id === "string" ? { kind: "incident", id, name: `${id} ${props.label}` } : undefined;
  return <MetricChart {...props} exportAs={subject && { subject }} />;
}
