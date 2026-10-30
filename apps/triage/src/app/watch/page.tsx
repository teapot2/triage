import { PlusIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Suspense } from "react";
import { EndpointList, EndpointListSkeleton } from "@/components/watch/endpoint-list";
import { NewEndpointButton } from "@/components/watch/new-endpoint-button";
import { RuleListSkeleton, WatchRuleList } from "@/components/watch/rule-list";

export const metadata: Metadata = { title: "Watch · Triage" };

// The live watch: the endpoints it checks itself and the rules it judges the
// store's traffic by, each with its live status and a page of its own.
// Pausing the watch itself stays in the sidebar, beside its status. New
// endpoint and New rule are the page's actions, at the right of its title
// like Run investigation on Incidents.
export default function WatchPage() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 pt-2 pb-8 md:pt-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-heading font-semibold text-2xl tracking-tight">Watch</h1>
          <div className="flex items-center gap-2">
            <NewEndpointButton />
            <Button size="sm" asChild>
              <Link href="/watch/new">
                <PlusIcon />
                New rule
              </Link>
            </Button>
          </div>
        </div>
        <p className="text-muted-foreground text-sm">
          Triage watches the live store&apos;s traffic and checks the URLs you add, and opens an incident on its own when
          a rule stays over its limit or an endpoint is slow or down.
        </p>
      </header>
      <section aria-labelledby="endpoints-heading" className="flex flex-col gap-3">
        <h2 id="endpoints-heading" className="font-medium text-sm">
          Endpoints
        </h2>
        <Suspense fallback={<EndpointListSkeleton />}>
          <EndpointList />
        </Suspense>
      </section>
      <section aria-labelledby="rules-heading" className="flex flex-col gap-3">
        <h2 id="rules-heading" className="font-medium text-sm">
          Rules
        </h2>
        {/* The list reads its search, filters and sort from the URL. */}
        <Suspense fallback={<RuleListSkeleton />}>
          <WatchRuleList />
        </Suspense>
      </section>
    </div>
  );
}
