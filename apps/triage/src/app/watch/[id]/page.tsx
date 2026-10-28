import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { RuleDetail } from "@/components/watch/rule-detail";
import { listIncidents } from "@/lib/investigation/store";
import { readRules } from "@/lib/investigation/watch-rules";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const rule = (await readRules()).find((r) => r.id === id);
  return { title: rule ? `${rule.name} · Watch · Triage` : "Watch · Triage" };
}

// One watch rule. Rules change at runtime, so params are awaited inside
// Suspense: the shell prerenders and the rule streams in (Cache Components).
export default function RulePage({ params }: Props) {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 pt-2 pb-8 md:pt-8 sm:px-6">
      <Suspense fallback={<RuleSkeleton />}>
        <Rule params={params} />
      </Suspense>
    </div>
  );
}

async function Rule({ params }: Props) {
  const { id } = await params;
  const rule = (await readRules()).find((r) => r.id === id);
  if (!rule) notFound();
  // The incidents this rule opened, newest first (the store's order).
  const incidents = (await listIncidents())
    .filter((i) => i.trigger.rule?.id === rule.id)
    .slice(0, 10)
    .map(({ id, title, status, detectedAt }) => ({ id, title, status, detectedAt }));
  return <RuleDetail rule={rule} incidents={incidents} />;
}

function RuleSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 border-b pb-6">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-5 w-80 max-w-full" />
      </div>
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
