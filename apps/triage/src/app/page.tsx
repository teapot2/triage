import { SirenIcon } from "lucide-react";
import { cookies } from "next/headers";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { Timestamp } from "@/components/timestamp";
import { IncidentStatusBadge, SeverityMeter, StatusIcon, statusLabel } from "@/components/incident/status-badges";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { isDemo } from "@/lib/investigation/demo";
import { facetCounts, filterIncidents } from "@/lib/investigation/filter";
import { investigationOptions } from "@/lib/investigation/options";
import type { Incident } from "@/lib/investigation/schema";
import { sortIncidents, startedAt } from "@/lib/investigation/sort";
import { isExample, listIncidents } from "@/lib/investigation/store";
import { incidentHeadline } from "@/lib/investigation/summary";
import { IncidentToolbar } from "./incident-toolbar";
import { clampPage, listHref, PAGE_SIZE_COOKIE, pageSizes, parseListParams } from "./list-params";
import { Pagination } from "./pagination";
import { RunInvestigation } from "./run-investigation";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default function Home({ searchParams }: Props) {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 pt-2 pb-8 md:pt-8 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-heading font-semibold text-2xl tracking-tight">Incidents</h1>
        <RunInvestigation
          scenarios={investigationOptions}
        />
      </header>
      <Suspense fallback={<Skeleton className="h-40 w-full" />}>
        <IncidentList searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function IncidentList({ searchParams }: Props) {
  // Incidents change at runtime; read them per request.
  await connection();
  const found = await listIncidents();
  const savedSize = (await cookies()).get(PAGE_SIZE_COOKIE)?.value;
  const asked = parseListParams(await searchParams, savedSize);
  const matching = sortIncidents(filterIncidents(found, asked), asked.sort);
  const { page, pageCount } = clampPage(asked, matching.length);
  const params = { ...asked, page };
  const incidents = matching.slice((page - 1) * params.size, page * params.size);

  // Only without the bundled examples; it points at the button above.
  if (found.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed px-4 py-10 text-center">
        <SirenIcon className="mb-1 size-5 text-muted-foreground" />
        <p className="font-medium text-sm">No incidents yet</p>
        <p className="text-muted-foreground text-sm">
          Use Run investigation to replay recorded telemetry through the agent.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <IncidentToolbar params={params} counts={facetCounts(found)} shown={matching.length} total={found.length} />
      {matching.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center">
          <p className="text-muted-foreground text-sm">No incidents match.</p>
          <Button variant="outline" size="sm" asChild>
            <Link href={listHref({ ...params, q: "", filters: { status: [], severity: [], service: [] }, page: 1 })}>
              Clear search and filters
            </Link>
          </Button>
        </div>
      ) : (
        <IncidentRows incidents={incidents} />
      )}
      {/* Once there's more than the smallest page holds, so a larger page
          size that fits everything can still be changed back. */}
      {matching.length > pageSizes[0] && <Pagination params={params} pageCount={pageCount} total={matching.length} />}
    </div>
  );
}

// Replacing the skeleton, rows fade up one after another; the stagger caps
// at ten rows so a long list doesn't keep the bottom waiting.
function IncidentRows({ incidents }: { incidents: Incident[] }) {
  return (
    <ul className="divide-y rounded-lg border">
      {incidents.map((incident, i) => (
        <li
          key={incident.id}
          style={{ animationDelay: `${Math.min(i, 10) * 25}ms` }}
          className="animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-backwards duration-200 ease-out motion-reduce:animate-none"
        >
          <Link
            href={`/incidents/${incident.id}`}
            className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40"
          >
            <SeverityMeter severity={incident.severity} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate font-medium text-sm">{incident.title}</span>
              <span className="truncate text-muted-foreground text-xs">
                {/* On phones the status badge would leave the title a dozen
                    characters, so the status moves into this line. */}
                <span className="mr-1.5 inline-flex items-center gap-1 align-middle sm:hidden">
                  <StatusIcon status={incident.status} className="size-3" />
                  <span className="text-foreground">{statusLabel[incident.status]}</span>
                  <span>·</span>
                </span>
                {[
                  incident.service,
                  incidentHeadline(incident),
                  isExample(incident.id) && "example",
                  isDemo(incident.id) && "demo",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            <span className="hidden sm:inline-flex">
              <IncidentStatusBadge status={incident.status} />
            </span>
            {/* When the run started: what the list sorts by. Replays share
                their alert time, so it's the time that tells them apart. */}
            <span className="hidden w-32 shrink-0 text-right font-mono text-muted-foreground text-xs sm:block">
              <Timestamp date={startedAt(incident)} />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
