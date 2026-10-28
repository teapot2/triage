"use client";

import { LoaderCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { formatTime } from "@/components/incident/format";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { LiveRequest, LiveTrace } from "@/lib/live/types";
import { cn } from "@/lib/utils";

// A request's spans as a waterfall, in a side sheet: each span's name
// (indented under its parent), what it queried, and a bar for when it ran
// within the request. Answers "why was this one slow?" without starting an
// investigation.
export function TraceSheet({ request, onClose }: { request?: LiveRequest; onClose: () => void }) {
  return (
    <Sheet open={request !== undefined} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-2xl">
        {request && <TraceDetail request={request} />}
      </SheetContent>
    </Sheet>
  );
}

function TraceDetail({ request }: { request: LiveRequest }) {
  const [state, setState] = useState<{ traceId: string; trace?: LiveTrace; error?: string }>();
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/live/trace?traceId=${request.traceId}`, { cache: "no-store", signal: ctrl.signal })
      .then(async (res) => {
        const body = (await res.json()) as LiveTrace & { error?: string };
        setState(res.ok ? { traceId: request.traceId, trace: body } : { traceId: request.traceId, error: body.error });
      })
      .catch((err) => !ctrl.signal.aborted && setState({ traceId: request.traceId, error: String(err) }));
    return () => ctrl.abort();
  }, [request.traceId]);
  const current = state?.traceId === request.traceId ? state : undefined;

  return (
    <>
      <SheetHeader className="border-b">
        <SheetTitle className="font-mono text-sm">
          {request.method} {request.route}
        </SheetTitle>
        <SheetDescription className="flex flex-wrap gap-x-2 font-mono text-xs">
          <span>{formatTime(new Date(request.time).toISOString())} UTC</span>
          <span>·</span>
          <span className={cn(request.failed && "text-destructive")}>{request.status || "no status"}</span>
          <span>·</span>
          <span>{request.durationMs} ms</span>
          <span>·</span>
          <span className="truncate">trace {request.traceId}</span>
        </SheetDescription>
      </SheetHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!current ? (
          <p className="flex items-center gap-2 text-muted-foreground text-sm">
            <LoaderCircleIcon className="size-4 animate-spin" />
            Loading spans…
          </p>
        ) : current.error || !current.trace ? (
          <p className="text-muted-foreground text-sm">{current.error ?? "No spans for this trace."}</p>
        ) : (
          <Waterfall trace={current.trace} />
        )}
      </div>
    </>
  );
}

function Waterfall({ trace }: { trace: LiveTrace }) {
  const total = Math.max(trace.durationMs, 0.1);
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col">
        {trace.spans.map((s) => (
          <li
            key={s.spanId}
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_4rem] items-center gap-3 py-1 text-xs"
          >
            <div className="min-w-0" style={{ paddingLeft: `${Math.min(s.depth, 8) * 12}px` }}>
              <div className={cn("truncate", s.error && "text-destructive")} title={s.name}>
                {s.name}
              </div>
              {(s.detail || s.statusMessage) && (
                <div className="truncate font-mono text-[11px] text-muted-foreground" title={s.statusMessage ?? s.detail}>
                  {s.statusMessage ?? s.detail}
                </div>
              )}
            </div>
            <div className="relative h-3 rounded-sm bg-muted/40">
              <div
                className={cn("absolute inset-y-0 rounded-sm", s.error ? "bg-destructive" : "bg-primary/70")}
                style={{
                  left: `${(s.offsetMs / total) * 100}%`,
                  width: `max(2px, ${(s.durationMs / total) * 100}%)`,
                }}
              />
            </div>
            <span className="text-right font-mono text-[11px] text-muted-foreground tabular-nums">{s.durationMs} ms</span>
          </li>
        ))}
      </ol>
      {trace.truncated && <p className="text-muted-foreground text-xs">Showing the first {trace.spans.length} spans.</p>}
    </div>
  );
}
