import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { Timestamp } from "@/components/timestamp";
import { StatusIcon, statusLabel } from "@/components/incident/status-badges";
import { Skeleton } from "@/components/ui/skeleton";
import type { Incident } from "@/lib/investigation/schema";
import { listIncidents } from "@/lib/investigation/store";
import { incidentHeadline, openStatuses } from "@/lib/investigation/summary";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Services · Triage" };

// The services Triage has investigated, from their incidents: whether any
// is open, and the latest one. Live health and dependencies come later.
export default function ServicesPage() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 pt-2 pb-8 md:pt-8 sm:px-6">
      <h1 className="font-heading font-semibold text-2xl tracking-tight">Services</h1>
      <Suspense fallback={<Skeleton className="h-24 w-full" />}>
        <ServiceList />
      </Suspense>
    </div>
  );
}

async function ServiceList() {
  // Incidents change at runtime; read them per request.
  await connection();
  const incidents = await listIncidents();

  // Newest first already, so each service's first incident is its latest.
  const services = new Map<string, Incident[]>();
  for (const i of incidents) services.set(i.service, [...(services.get(i.service) ?? []), i]);

  if (services.size === 0) {
    return (
      <div className="rounded-lg border border-dashed px-4 py-10 text-center text-muted-foreground text-sm">
        No services yet. They appear here once Triage investigates one.
      </div>
    );
  }

  return (
    <ul className="divide-y rounded-lg border">
      {[...services].map(([name, list]) => {
        const latest = list[0];
        const open = list.filter((i) => openStatuses.includes(i.status)).length;
        return (
          <li key={name} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
            <span className="flex min-w-32 items-center gap-2 font-medium text-sm">
              <span
                aria-hidden
                className={cn("size-2 rounded-full", open > 0 ? "bg-warning" : "bg-success")}
              />
              {name}
            </span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {open > 0 ? `${open} open` : "No open incidents"} · {list.length} total
            </span>
            <Link
              href={`/incidents/${latest.id}`}
              className="ml-auto flex min-w-0 items-center gap-2 text-sm hover:text-muted-foreground"
            >
              <StatusIcon status={latest.status} />
              <span className="truncate">{incidentHeadline(latest) ?? latest.title}</span>
              <span className="shrink-0 text-muted-foreground text-xs">
                {statusLabel[latest.status]} · <Timestamp date={latest.detectedAt} />
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
