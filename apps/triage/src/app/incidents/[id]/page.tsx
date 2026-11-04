import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { Suspense } from "react";
import { IncidentView } from "@/components/incident/incident-view";
import { Skeleton } from "@/components/ui/skeleton";
import { checkPrMerged } from "@/lib/investigation/fix/pr-merge";
import { fullContextModel } from "@/lib/investigation/ask/full-context-model";
import { sourceKind } from "@/lib/investigation/source-kind";
import { getIncident } from "@/lib/investigation/store";
import { isSparkOpen } from "@/lib/models/providers";
import { stageModel, stageProblem, webSearchOn } from "@/lib/models/settings";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const incident = await getIncident(id);
  return { title: incident ? `${incident.title} · Triage` : "Triage" };
}

// Incidents are created at runtime, so params are awaited inside Suspense:
// the shell prerenders and the incident streams in (Cache Components).
export default function IncidentPage({ params }: Props) {
  return (
    <Suspense fallback={<IncidentSkeleton />}>
      <Incident params={params} />
    </Suspense>
  );
}

async function Incident({ params }: Props) {
  const { id } = await params;
  const incident = await getIncident(id);
  if (!incident) notFound();
  // Whether the fix's PR has been merged since, checked after the page is
  // sent (at most once a minute; there's no background poll).
  const { approval } = incident;
  if (approval?.prState === "opened" && !approval.prMergedAt && incident.status !== "resolved") {
    after(() => checkPrMerged(incident));
  }
  // The Ask composer starts on Settings' Ask model (only its name: the
  // endpoint's key stays here), and its web search switch as Settings has
  // it; the switch shows while the chosen model is on Meta's API.
  const { provider, model, effort } = await stageModel("ask");
  // The full-context switch shows when there's telemetry to read and a model
  // to read it (Wonder, or the Ask stage's Spark Open), named on the switch.
  const full = sourceKind(incident) ? await fullContextModel() : undefined;
  const fullContext = full && !stageProblem(full) ? (isSparkOpen(full.model) ? "Spark Open" : "Wonder") : undefined;
  return (
    <IncidentView
      incident={incident}
      askModel={{ provider, model, effort }}
      webSearch={await webSearchOn()}
      fullContext={fullContext}
    />
  );
}

// The page's own frame (IncidentHeader, then IncidentReport's section menu
// beside Overview), so nothing shifts when the incident streams in.
function IncidentSkeleton() {
  return (
    <>
      <div className="mx-auto w-full max-w-6xl px-4 pt-2 sm:px-6 md:pt-8">
        <div className="flex flex-col gap-2 border-b pb-4">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-5 w-96 max-w-full" />
        </div>
      </div>
      <div className="mx-auto w-full max-w-6xl px-4 pt-5 pb-8 sm:px-6">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 md:grid-cols-[11rem_minmax(0,1fr)] md:gap-10">
          <div className="flex gap-1 md:flex-col">
            {["overview", "fix", "investigation"].map((id) => (
              <Skeleton key={id} className="h-8 w-24 md:w-full" />
            ))}
          </div>
          {/* Verdict card, proposed fix, alert chart card. The section has no
              visible title, so the first card starts level with the menu. The
              verdict's height follows its text; this is its usual collapsed
              height at desktop widths. */}
          <div className="flex flex-col gap-8">
            <Skeleton className="h-44 w-full" />
            <Skeleton className="h-42 w-full" />
            <Skeleton className="h-55.5 w-full" />
          </div>
        </div>
      </div>
    </>
  );
}
