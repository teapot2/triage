import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { RuleForm } from "@/components/watch/rule-form";
import { readRules } from "@/lib/investigation/watch-rules";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const rule = (await readRules()).find((r) => r.id === id);
  return { title: rule ? `Edit ${rule.name} · Watch · Triage` : "Watch · Triage" };
}

// The only place a watch rule changes. Params are awaited inside Suspense,
// as on the rule's page.
export default function EditRulePage({ params }: Props) {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 pt-2 pb-8 md:pt-8 sm:px-6">
      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <Edit params={params} />
      </Suspense>
    </div>
  );
}

async function Edit({ params }: Props) {
  const { id } = await params;
  const rule = (await readRules()).find((r) => r.id === id);
  if (!rule) notFound();
  return <RuleForm rule={rule} />;
}
