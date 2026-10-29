import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import type { ServiceRow } from "@/components/services/service-filters";
import { ServiceList, ServiceListSkeleton } from "@/components/services/service-list";
import type { Incident } from "@/lib/investigation/schema";
import { readTelemetry } from "@/lib/investigation/live/otlp-files";
import { liveService } from "@/lib/live/types";
import { listIncidents } from "@/lib/investigation/store";
import { incidentHeadline, openStatuses } from "@/lib/investigation/summary";

export const metadata: Metadata = { title: "Services · Triage" };

// The services Triage knows: those it has investigated, from their
// incidents (whether any is open, and the latest one), and those sending
// telemetry now, with the app's search, filters and sort above them.
export default function ServicesPage() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 pt-2 pb-8 md:pt-8 sm:px-6">
      <h1 className="font-heading font-semibold text-2xl tracking-tight">Services</h1>
      <Suspense fallback={<ServiceListSkeleton />}>
        <Services />
      </Suspense>
    </div>
  );
}

async function Services() {
  // Incidents change at runtime; read them per request.
  await connection();
  const [incidents, telemetry] = await Promise.all([listIncidents(), readTelemetry()]);

  // Newest first already, so each service's first incident is its latest.
  const byService = new Map<string, Incident[]>();
  for (const i of incidents) byService.set(i.service, [...(byService.get(i.service) ?? []), i]);
  // Services with a live page: those sending telemetry, and the live one
  // even while it's stopped. Ones known only from recorded incidents (the
  // demo scenarios' services) have nothing live to show.
  const live = new Set([liveService, ...telemetry.spans.map((s) => s.service)]);
  live.delete("unknown");
  for (const s of live) if (!byService.has(s)) byService.set(s, []);

  if (byService.size === 0) {
    return (
      <div className="rounded-lg border border-dashed px-4 py-10 text-center text-muted-foreground text-sm">
        No services yet. They appear here once one sends telemetry or Triage investigates one.
      </div>
    );
  }

  const services: ServiceRow[] = [...byService].map(([name, list]) => {
    const latest = list.at(0);
    return {
      name,
      live: live.has(name),
      open: list.filter((i) => openStatuses.includes(i.status)).length,
      total: list.length,
      latest: latest && {
        id: latest.id,
        status: latest.status,
        headline: incidentHeadline(latest) ?? latest.title,
        detectedAt: latest.detectedAt,
        ranAt: latest.run?.startedAt ?? latest.detectedAt,
      },
    };
  });
  return <ServiceList services={services} />;
}
