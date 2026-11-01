"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { IncidentView } from "@/components/incident/incident-view";
import type { Incident } from "@/lib/investigation/schema";
import { cn } from "@/lib/utils";

// Which state of the fixture to show, from ?state=running, with a switch
// between them above the incident.
export function FanoutPreview({ finished, running }: { finished: Incident; running: Incident }) {
  const live = useSearchParams().get("state") === "running";
  const incident = live ? running : finished;
  return (
    <>
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-2 text-muted-foreground text-xs sm:px-6 md:pt-4">
        <span>Fan-out fixture (dev only)</span>
        <nav aria-label="Fixture state" className="inline-flex rounded-md bg-muted p-0.5">
          {[
            { label: "Finished", href: "/dev/fanout", active: !live },
            { label: "Running", href: "/dev/fanout?state=running", active: live },
          ].map((s) => (
            <Link
              key={s.label}
              href={s.href}
              aria-current={s.active ? "page" : undefined}
              className={cn(
                "flex h-6 items-center rounded-[5px] px-2 transition-colors",
                s.active ? "bg-background text-foreground shadow-sm" : "hover:text-foreground",
              )}
            >
              {s.label}
            </Link>
          ))}
        </nav>
      </div>
      {/* Keyed, so switching starts the view afresh (its default section
          and timeline view depend on whether it's running). */}
      <IncidentView key={incident.id} incident={incident} />
    </>
  );
}
