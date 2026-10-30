"use client";

import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import type { UptimeCheck } from "@/lib/investigation/uptime/model";
import { cn } from "@/lib/utils";
import {
  EndpointBadge,
  type EndpointState,
  endpointStatus,
  resultLine,
  useClock,
  useEndpointDetail,
} from "./endpoint-client";
import { ResultStrip } from "./result-strip";

// One check on the Watch page: its name and live status, the URL, the last
// result in a line, and the strip of the last 20, all a link to the check's
// own page. Its results are polled here; its state comes from the watch's,
// like a rule's, so every badge on the page changes together.
export function EndpointCard({
  check,
  state,
  watchOn,
}: {
  check: UptimeCheck;
  state: EndpointState | undefined;
  watchOn: boolean | undefined;
}) {
  const { data } = useEndpointDetail(check.id);
  const now = useClock();
  const status = endpointStatus(check, state, watchOn);
  const quiet = status === "paused" || status === "checking";
  return (
    <Link
      href={`/watch/endpoints/${check.id}`}
      className="flex w-full min-w-0 flex-col gap-3 rounded-lg border p-4 outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <span className="flex items-start gap-2">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-medium text-sm">{check.name}</span>
          <span className="truncate font-mono text-muted-foreground text-xs">{check.url}</span>
        </span>
        <EndpointBadge status={status} />
        <ChevronRightIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      </span>
      <span className={cn("text-sm tabular-nums", quiet && "text-muted-foreground")}>
        {status === "paused" ? "Not being checked." : resultLine(state, now)}
      </span>
      <ResultStrip samples={data?.samples ?? []} className={cn(quiet && "opacity-60")} />
    </Link>
  );
}
