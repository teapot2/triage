import { PlusIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Suspense } from "react";
import { RuleListSkeleton, WatchRuleList } from "@/components/watch/rule-list";

export const metadata: Metadata = { title: "Watch · Triage" };

// The live watch: the rules it judges the store's traffic by, each with its
// live status and a page of its own. Pausing the watch itself stays in the
// sidebar, beside its status. New rule is the page's action, at the right
// of its title like Run investigation on Incidents.
export default function WatchPage() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 pt-2 pb-8 md:pt-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-heading font-semibold text-2xl tracking-tight">Watch</h1>
          <Button size="sm" asChild>
            <Link href="/watch/new">
              <PlusIcon />
              New rule
            </Link>
          </Button>
        </div>
        <p className="text-muted-foreground text-sm">
          Triage watches the live store&apos;s traffic and opens an incident on its own when a rule stays over its limit.
        </p>
      </header>
      {/* The list reads its search, filters and sort from the URL. */}
      <Suspense fallback={<RuleListSkeleton />}>
        <WatchRuleList />
      </Suspense>
    </div>
  );
}
