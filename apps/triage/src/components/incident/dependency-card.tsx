"use client";

import { ArrowRightIcon, ChevronRightIcon, ExternalLinkIcon, PackageIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Timestamp } from "@/components/timestamp";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { AdvisorySeverityBadge, Chains, packageAt } from "@/components/watch/dependency-client";
import { plural } from "@/components/watch/watch-client";
import type { DependencyAdvisory } from "@/lib/investigation/schema";

// What a dependency incident is about, first on its Overview: the advisory,
// the package at the versions the service holds and the range that fixes
// it, its severity, and whether it runs in production and how it gets in,
// in three lines. The rest (the vulnerable range, every chain, the audits
// that found it) waits under Details: the page answers what's vulnerable
// before it shows how Triage knows.

// A chain whose head is the vulnerable package itself: the service
// depends on it directly.
const directly = (d: DependencyAdvisory) => d.paths.some((p) => !p.includes(">"));

// "a runtime dependency of the service" / "dev only, through drizzle-kit".
function reach(d: DependencyAdvisory): string {
  const runs = d.dev ? "Dev only" : "Runtime";
  if (directly(d)) return `${runs}, the service's own dependency`;
  const [via, ...more] = d.direct;
  return `${runs}, through ${via}${more.length ? ` and ${plural(more.length, "other", "others")}` : ""}`;
}

export function AdvisoryCard({ advisory: d }: { advisory: DependencyAdvisory }) {
  return (
    <Collapsible className="group/advisory flex flex-col rounded-lg border">
      <div className="flex flex-col gap-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <PackageIcon className="size-3.5" />
            Dependency advisory ·{" "}
            <a
              href={d.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-mono hover:text-foreground"
            >
              {d.advisoryId}
              <ExternalLinkIcon className="size-3" aria-hidden />
              <span className="sr-only">(opens the advisory)</span>
            </a>
          </span>
          <span className="flex items-center gap-2">
            <AdvisorySeverityBadge severity={d.severity} />
            {d.cwe.length > 0 && <span className="font-mono text-muted-foreground">{d.cwe.join(", ")}</span>}
          </span>
        </div>
        {d.title && <h2 className="font-heading font-medium text-lg leading-snug">{d.title}</h2>}
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
          <span className={d.goneAt ? "font-mono text-muted-foreground line-through" : "font-mono"}>{packageAt(d)}</span>
          <ArrowRightIcon className="size-3.5 text-muted-foreground" aria-label="fixed in" />
          {d.patched ? <span className="font-mono">{d.patched}</span> : <span className="text-muted-foreground">no fix published</span>}
          <span aria-hidden className="text-muted-foreground">
            ·
          </span>
          <span className="text-muted-foreground">{reach(d)}</span>
        </p>
      </div>
      <CollapsibleTrigger className="flex w-full items-center gap-1 border-t px-4 py-2.5 text-muted-foreground text-sm transition-colors hover:text-foreground">
        <ChevronRightIcon className="size-4 transition-[rotate] duration-200 group-data-[state=open]/advisory:rotate-90 motion-reduce:transition-none" />
        Details
        <span className="ml-auto text-xs">Found in {plural(d.audits, "audit", "audits")}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="grid gap-x-6 gap-y-3 border-t px-4 py-3 text-sm sm:grid-cols-2">
          <Fact label="Vulnerable versions">
            <span className="font-mono text-xs">{d.vulnerable || "—"}</span>
          </Fact>
          <Fact label="Audits">
            Last found <Timestamp date={d.lastFoundAt} />
            {d.goneAt && (
              <span className="text-success">
                , gone since <Timestamp date={d.goneAt} />
              </span>
            )}
          </Fact>
          {!directly(d) && (
            <Fact label="Pulled in by" wide>
              <Chains paths={d.paths} />
            </Fact>
          )}
          <Fact label="Audit" wide>
            <Button variant="link" size="xs" className="h-auto p-0" asChild>
              <Link href="/watch#dependencies">
                Every finding on the Watch page <ArrowRightIcon />
              </Link>
            </Button>
          </Fact>
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Fact({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={wide ? "flex min-w-0 flex-col gap-0.5 sm:col-span-2" : "flex min-w-0 flex-col gap-0.5"}>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
