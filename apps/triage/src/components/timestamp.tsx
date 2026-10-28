"use client";

import type { ReactNode } from "react";
import { formatDateTime, formatFullTimestamp } from "@/components/incident/format";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// A point in time: shows it short ("Oct 26, 21:26 UTC", or whatever the
// place passes as children: a time, "3h ago"), and on hover the whole thing
// to the millisecond, in UTC like the rest of the app, with the viewer's
// own clock under it. A <time> element, so the exact value is in the markup.
// The tooltip renders only in the browser, so the local time (which the
// server can't know) never meets hydration.
export function Timestamp({
  date,
  children,
  className,
}: {
  date: string | number | Date;
  children?: ReactNode;
  className?: string;
}) {
  const iso = new Date(date).toISOString();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          dateTime={iso}
          className={cn("cursor-default decoration-dotted underline-offset-4 hover:underline", className)}
        >
          {children ?? formatDateTime(iso)}
        </time>
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start gap-0.5">
        <span className="font-mono tabular-nums">{formatFullTimestamp(iso)}</span>
        <LocalTime iso={iso} />
      </TooltipContent>
    </Tooltip>
  );
}

// The same moment on the viewer's clock, unless they're on UTC already.
function LocalTime({ iso }: { iso: string }) {
  const d = new Date(iso);
  if (d.getTimezoneOffset() === 0) return null;
  const local = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(d);
  return <span className="opacity-70">{local} your time</span>;
}
