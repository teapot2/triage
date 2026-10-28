import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { LiveService } from "@/components/live/live-service";
import { Skeleton } from "@/components/ui/skeleton";

type Props = { params: Promise<{ service: string }> };

const serviceName = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { service } = await params;
  return { title: `${service} · Services · Triage` };
}

// One service, live: its traffic, latency, errors and database pool as
// they arrive, polled from /api/live. The page itself is a shell; the
// numbers stream in on the client.
export default function ServicePage({ params }: Props) {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 pt-2 pb-8 md:pt-8 sm:px-6">
      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <Service params={params} />
      </Suspense>
    </div>
  );
}

async function Service({ params }: Props) {
  const { service } = await params;
  if (!serviceName.test(service)) notFound();
  return <LiveService service={service} />;
}
