"use client";

import { formatAgo } from "@/components/incident/format";
import { SeverityBars, StatusIcon, statusLabel } from "@/components/incident/status-badges";
import type { RecentIncident } from "./app-sidebar-nav";

// What a sidebar row's hover card says about its incident, kept to a
// glance: the full title (the row cuts it off), one quiet line of status,
// severity and age, and the takeaway (see incidentPreview). Everything else
// is on the incident's page.
export function IncidentPreview({ incident, now }: { incident: RecentIncident; now: number }) {
  const ago = formatAgo(incident.activityAt, now);
  const { takeaway } = incident.preview;
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-start gap-2 font-medium leading-snug">
        <StatusIcon status={incident.status} className="mt-px" />
        <span className="line-clamp-2">{incident.title}</span>
      </p>
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 pl-6 text-muted-foreground text-xs">
        {statusLabel[incident.status]}
        <span aria-hidden>·</span>
        <span className="inline-flex items-center gap-1 font-mono uppercase">
          <SeverityBars severity={incident.severity} className="h-3 w-3.5" />
          {incident.severity}
        </span>
        <span aria-hidden>·</span>
        <span className="tabular-nums">{ago === "now" ? "just now" : `${ago} ago`}</span>
      </p>
      {takeaway && <p className="line-clamp-2 pl-6 text-xs leading-relaxed">{takeaway}</p>}
    </div>
  );
}
