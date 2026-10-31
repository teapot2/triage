import type { Metadata } from "next";
import { Suspense } from "react";
import { EndpointDetail, EndpointSkeleton } from "@/components/watch/endpoint-detail";

export const metadata: Metadata = { title: "Endpoint · Watch · Triage" };

type Props = { params: Promise<{ id: string }> };

// One uptime check. Its state and results change every few seconds, so the
// page reads them in the browser, as the Watch list does; the shell
// prerenders and the id is awaited inside Suspense (Cache Components). The
// detail lays out its own column, so its sticky header can span the page.
export default function EndpointPage({ params }: Props) {
  return (
    <div className="pt-2 pb-8 md:pt-8">
      <Suspense fallback={<EndpointSkeleton />}>
        <Endpoint params={params} />
      </Suspense>
    </div>
  );
}

async function Endpoint({ params }: Props) {
  const { id } = await params;
  return <EndpointDetail id={id} />;
}
