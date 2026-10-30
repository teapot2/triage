import type { Metadata } from "next";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { EndpointForm } from "@/components/watch/endpoint-form";

export const metadata: Metadata = { title: "Edit endpoint · Watch · Triage" };

type Props = { params: Promise<{ id: string }> };

// The only place an uptime check changes. Params are awaited inside Suspense,
// as on the check's page.
export default function EditEndpointPage({ params }: Props) {
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
  return <EndpointForm id={id} />;
}
