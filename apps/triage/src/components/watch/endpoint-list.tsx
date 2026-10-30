"use client";

import { GlobeIcon } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EndpointCard } from "./endpoint-card";
import { useChecks, useEndpointStates } from "./endpoint-client";

// The Watch page's Endpoints section: a card for each uptime check, with its
// live status from the watch. Nothing here edits one; that's the check's own
// page, like the rules.
export function EndpointList() {
  const { checks, error, retry } = useChecks();
  const { watch, endpoints } = useEndpointStates();

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t load the endpoints</AlertTitle>
        <AlertDescription className="break-words">{error}</AlertDescription>
        <AlertAction>
          <Button variant="outline" size="xs" onClick={retry}>
            Retry
          </Button>
        </AlertAction>
      </Alert>
    );
  }

  if (!checks) return <EndpointListSkeleton />;

  if (checks.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed px-4 py-8 text-center">
        <GlobeIcon className="mb-1 size-5 text-muted-foreground" aria-hidden />
        <p className="text-muted-foreground text-sm">
          No endpoints. Add a public URL and Triage checks it itself, opening an incident when it&apos;s slow or down.
        </p>
      </div>
    );
  }

  const states = new Map(endpoints?.map((e) => [e.id, e]));
  return (
    <ul aria-label="Endpoints" className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
      {checks.map((check) => (
        <li key={check.id} className="flex">
          <EndpointCard check={check} state={states.get(check.id)} watchOn={watch?.enabled} />
        </li>
      ))}
    </ul>
  );
}

export function EndpointListSkeleton() {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2" aria-busy="true">
      {[0, 1].map((i) => (
        <div key={i} className="flex flex-col gap-3 rounded-lg border p-4">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-48" />
          <Skeleton className="h-5 w-full" />
        </div>
      ))}
    </div>
  );
}
