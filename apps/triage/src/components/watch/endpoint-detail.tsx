"use client";

import { ActivityIcon, LoaderCircleIcon, PencilIcon } from "lucide-react";
import Link from "next/link";
import { notFound, useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { formatTime } from "@/components/incident/format";
import { MetricChart } from "@/components/incident/metric-chart";
import { Timestamp } from "@/components/timestamp";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { StatusBadge, type StatusTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { describeCheck, duration, type UptimeCheck, type UptimeSample } from "@/lib/investigation/uptime/model";
import {
  checkNow,
  EndpointBadge,
  endpointStatus,
  resultLine,
  updateEndpoints,
  useClock,
  useEndpointDetail,
  useEndpointStates,
} from "./endpoint-client";
import { plural } from "./watch-client";
import { WatchHeader } from "./watch-header";

const outcomeBadge: Record<UptimeSample["outcome"], { label: string; tone: StatusTone }> = {
  ok: { label: "OK", tone: "success" },
  slow: { label: "Slow", tone: "warning" },
  down: { label: "Down", tone: "destructive" },
};

// A check's own page, read-only: its live status and last result, the
// response-time chart with the slow limit drawn, the last 50 results, and its
// configuration beside them. Changing it is the Edit page; Check now and
// Delete are deliberate buttons.
export function EndpointDetail({ id }: { id: string }) {
  const router = useRouter();
  const { data, missing, error, refresh } = useEndpointDetail(id);
  const { watch, endpoints } = useEndpointStates();
  const now = useClock();
  const [checking, setChecking] = useState(false);
  const [actionError, setActionError] = useState<{ title: string; reason: string }>();

  if (missing) notFound();
  if (!data) {
    return error ? (
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t load the endpoint</AlertTitle>
        <AlertDescription className="break-words">{error}</AlertDescription>
        <AlertAction>
          <Button variant="outline" size="xs" onClick={refresh}>
            Retry
          </Button>
        </AlertAction>
      </Alert>
    ) : (
      <EndpointSkeleton />
    );
  }

  const { check, samples } = data;
  // The watch's state when it has one, so this badge changes with the list's.
  const state = endpoints?.find((e) => e.id === id) ?? data.state;
  const status = endpointStatus(check, state, watch?.enabled);

  async function runNow() {
    setChecking(true);
    setActionError(undefined);
    const result = await checkNow(id);
    if (result.error) setActionError({ title: "Couldn't run the check", reason: result.error });
    refresh();
    setChecking(false);
  }

  async function remove() {
    setActionError(undefined);
    const result = await updateEndpoints((checks) => checks.filter((c) => c.id !== id));
    if (result.error) return setActionError({ title: "Couldn't delete the endpoint", reason: result.error });
    router.push("/watch");
    router.refresh();
  }

  const points = samples.map((s) => ({ t: s.at, value: s.ms }));
  return (
    <div className="flex flex-col gap-6">
      <WatchHeader
        crumbs={[{ label: "Watch", href: "/watch" }]}
        title={check.name}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void runNow()} disabled={checking}>
              {checking ? <LoaderCircleIcon className="animate-spin" /> : <ActivityIcon />}
              Check now
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href={`/watch/endpoints/${check.id}/edit`}>
                <PencilIcon />
                Edit
              </Link>
            </Button>
            <DeleteEndpoint name={check.name} onConfirm={() => void remove()} />
          </>
        }
      >
        <EndpointBadge status={status} />
        <span className="sm:ml-1">
          {status === "paused" ? "Not being checked." : resultLine(state, now)}
        </span>
      </WatchHeader>

      {actionError && (
        <Alert variant="destructive" dismissible dismissLabel="Dismiss error" onDismiss={() => setActionError(undefined)}>
          <AlertTitle>{actionError.title}</AlertTitle>
          <AlertDescription className="break-words">{actionError.reason}</AlertDescription>
        </Alert>
      )}

      {state.incidentId && (
        <Alert variant="destructive">
          <AlertTitle>An incident is open for this endpoint</AlertTitle>
          <AlertDescription>It stays open until its checks come back healthy.</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="xs" asChild>
              <Link href={`/incidents/${state.incidentId}`}>View incident</Link>
            </Button>
          </AlertAction>
        </Alert>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 md:grid-cols-[minmax(0,1fr)_17rem] md:gap-8">
        <div className="flex min-w-0 flex-col gap-6">
          <Section title="Response time">
            {points.length < 2 ? (
              <p className="text-muted-foreground text-sm">
                {status === "paused" ? "Paused, so nothing is being checked." : "The chart appears after the second check."}
              </p>
            ) : (
              <div className="flex flex-col gap-2 rounded-lg border p-4">
                <MetricChart series={points} label="Response time" unit="ms" threshold={check.slowMs} />
              </div>
            )}
          </Section>

          <Section title={`Last ${plural(Math.min(samples.length, 50), "result", "results")}`}>
            {samples.length === 0 ? (
              <p className="text-muted-foreground text-sm">No results yet.</p>
            ) : (
              <ResultTable samples={samples} />
            )}
          </Section>
        </div>

        <Configuration check={check} />
      </div>
    </div>
  );
}

function ResultTable({ samples }: { samples: UptimeSample[] }) {
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Result</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Response</TableHead>
            <TableHead>Error</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {samples
            .slice(-50)
            .toReversed()
            .map((s) => {
              const { label, tone } = outcomeBadge[s.outcome];
              return (
                <TableRow key={s.at}>
                  <TableCell>
                    <Timestamp date={s.at} className="font-mono text-xs tabular-nums">
                      {formatTime(s.at)}
                    </Timestamp>
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone={tone}>{label}</StatusBadge>
                  </TableCell>
                  <TableCell className="tabular-nums">{s.status ?? "–"}</TableCell>
                  <TableCell className="text-right tabular-nums">{duration(s.ms)}</TableCell>
                  <TableCell className="max-w-64 truncate text-muted-foreground text-xs" title={s.error}>
                    {s.error ?? ""}
                  </TableCell>
                </TableRow>
              );
            })}
        </TableBody>
      </Table>
    </div>
  );
}

function Configuration({ check }: { check: UptimeCheck }) {
  const { min, max } = check.expectedStatus;
  return (
    <aside aria-label="Configuration" className="flex flex-col gap-3 md:border-l md:pl-8">
      <h2 className="font-medium text-sm">Configuration</h2>
      <p className="text-muted-foreground text-sm">{describeCheck(check)}.</p>
      <dl className="flex flex-col gap-3 text-sm">
        <Fact label="URL">
          <span className="break-all font-mono text-xs">{check.url}</span>
        </Fact>
        <Fact label="Expected status">{min === max ? min : `${min}–${max}`}</Fact>
        <Fact label="Slow opens an incident after">
          {plural(check.slowChecksToOpen, "check", "checks")} slower than {duration(check.slowMs)} in a row
          <span className="text-muted-foreground"> (SEV3)</span>
        </Fact>
        <Fact label="Down opens an incident after">
          {plural(check.downMinutesToOpen, "minute", "minutes")} with no good answer
          <span className="text-muted-foreground"> (SEV2)</span>
        </Fact>
        <Fact label="Recovered after">{plural(check.healthyChecksToRecover, "healthy check", "healthy checks")} in a row</Fact>
      </dl>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-medium text-sm">{title}</h2>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// Deletes the check after a confirm, with its results. An incident it
// already opened stays.
function DeleteEndpoint({ name, onConfirm }: { name: string; onConfirm: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm">
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Triage stops checking it and forgets its results, and an incident it already opened stays. To stop it for a
            while instead, pause it from its Edit page.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Delete endpoint
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function EndpointSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 border-b pb-6">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-5 w-80 max-w-full" />
      </div>
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
