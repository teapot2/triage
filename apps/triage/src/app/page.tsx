import { SirenIcon } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { formatDateTime } from "@/components/incident/format";
import { IncidentStatusBadge, SeverityBadge, StatusDot, statusLabel } from "@/components/incident/status-badges";
import { Skeleton } from "@/components/ui/skeleton";
import { isDemo } from "@/lib/investigation/demo";
import { investigationOptions } from "@/lib/investigation/options";
import { parseSort, sortIncidents, startedAt } from "@/lib/investigation/sort";
import { isExample, listIncidents } from "@/lib/investigation/store";
import { incidentHeadline } from "@/lib/investigation/summary";
import { PAGE_SIZE, Pagination, parsePage } from "./pagination";
import { RunInvestigation } from "./run-investigation";
import { SortMenu } from "./sort-menu";

type Props = { searchParams: Promise<{ sort?: string | string[]; page?: string | string[] }> };

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
  const params = await searchParams;
  const sort = parseSort(params.sort);
  const all = sortIncidents(await listIncidents(), sort);
  const pageCount = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const page = parsePage(params.page, pageCount);
  const incidents = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Only without the bundled examples; it points at the button above.
  if (incidents.length === 0) {
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

  // Replacing the skeleton, rows fade up one after another; the stagger caps
  // at ten rows so a long list doesn't keep the bottom waiting.
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground text-sm tabular-nums">
          {all.length} {all.length === 1 ? "incident" : "incidents"}
        </span>
        <SortMenu value={sort} />
      </div>
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
              <SeverityBadge severity={incident.severity} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate font-medium text-sm">{incident.title}</span>
                <span className="truncate text-muted-foreground text-xs">
                  {/* On phones the status badge would leave the title a dozen
                      characters, so the status moves into this line. */}
                  <span className="mr-1.5 inline-flex items-center gap-1 align-middle sm:hidden">
                    <StatusDot status={incident.status} />
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
                {formatDateTime(startedAt(incident))}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {pageCount > 1 && <Pagination page={page} pageCount={pageCount} total={all.length} sort={sort} />}
    </div>
  );
}
