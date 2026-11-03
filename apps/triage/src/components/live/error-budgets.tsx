"use client";

import Link from "next/link";
import { type ComponentProps, useState } from "react";
import { ExportMenu } from "@/components/export-menu";
import { MetricChart } from "@/components/incident/metric-chart";
import { StatusBadge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { sentence } from "@/components/watch/watch-client";
import { sloBudget, sloBudgetRows } from "@/lib/export/datasets/slo";
import type { ChartPoint } from "@/lib/investigation/schema";
import type { LiveSlo } from "@/lib/live/types";
import { budgetText, burnText, sloText } from "@/lib/slo/model";
import { cn } from "@/lib/utils";

type ExportAs = NonNullable<ComponentProps<typeof MetricChart>["exportAs"]>;

// The SLO rules' error budgets on the service page: one card each, with the
// budget left on its lowest route, how fast it's burning, and how it was
// spent across the SLO window. They come from the request counts Triage
// keeps, not the page's window, so each says its own.
export function ErrorBudgets({ slos, exportAs }: { slos: LiveSlo[]; exportAs: ExportAs }) {
  const rows = sloBudgetRows(slos);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium text-sm">Error budget</h2>
        {rows.length > 0 && <ExportMenu size="xs" exports={[{ dataset: sloBudget, rows, subject: exportAs.subject }]} />}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {slos.map((slo) => (
          <BudgetCard key={slo.ruleId} slo={slo} />
        ))}
      </div>
    </section>
  );
}

// "Nov 2, 06:00", for a point on a burndown that spans days.
const day = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function BudgetCard({ slo }: { slo: LiveSlo }) {
  const [hovered, setHovered] = useState<ChartPoint>();
  const lowest = slo.routes[0];
  const over = lowest !== undefined && lowest.budgetLeftPercent < 0;
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h3 className="font-medium text-sm">
            <Link href={`/watch/${slo.ruleId}`} className="rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
              {slo.name}
            </Link>
          </h3>
          {lowest?.alert && (
            <StatusBadge tone={lowest.alert === "fast" ? "destructive" : "warning"} pulse>
              {lowest.alert === "fast" ? "Burning fast" : "Burning slowly"}
            </StatusBadge>
          )}
        </div>
        <p className="text-muted-foreground text-xs">{sentence(sloText(slo))}</p>
      </div>

      {!lowest ? (
        <p className="text-muted-foreground text-sm">No requests on the routes it covers in the last {slo.windowDays} days.</p>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className={cn("font-medium font-mono text-lg tabular-nums", over && "text-destructive")}>
                {over ? `${budgetText(-lowest.budgetLeftPercent)} over budget` : `${budgetText(lowest.budgetLeftPercent)} left`}
              </span>
              <span className="min-w-0 truncate text-muted-foreground text-xs">
                {slo.routes.length > 1 ? "lowest, " : ""}
                <span className="font-mono">
                  {lowest.method} {lowest.route}
                </span>
              </span>
            </div>
            <Progress
              value={Math.max(0, Math.min(100, lowest.budgetLeftPercent))}
              aria-label="Error budget left"
              className={cn(over && "bg-destructive/20")}
            />
            {/* A budget on a few dozen requests swings far on one bad
                one, so the count is beside it. */}
            <p className="font-mono text-muted-foreground text-xs tabular-nums">
              {burnText(lowest.burn1h)} over 1 h · {burnText(lowest.burn6h)} over 6 h · {lowest.requests.toLocaleString()} requests
            </p>
          </div>

          {/* A line needs two points: under one step of the window (6 h
              of 30 days) there's only the one. */}
          {slo.burndown.filter((p) => p.value !== null).length > 1 && (
            <div className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2 text-muted-foreground text-xs">
                <span>Spent over {slo.windowDays} days</span>
                <span className="font-mono tabular-nums">
                  {hovered?.value != null ? `${day(hovered.t)} · ${budgetText(hovered.value)} left` : ""}
                </span>
              </div>
              <MetricChart series={slo.burndown} label={`${slo.name} budget left`} unit="%" compact onHover={setHovered} className="h-16" />
            </div>
          )}

          {slo.routes.length > 1 && (
            <div className="rounded-md border [&_tr>*:first-child]:pl-3 [&_tr>*:last-child]:pr-3">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Route</TableHead>
                    <TableHead className="w-14 text-right">Left</TableHead>
                    <TableHead className="w-18 text-right">1 h burn</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {slo.routes.map((r) => (
                    <TableRow key={r.route}>
                      <TableCell className="max-w-0 truncate font-mono text-xs">
                        <span className="text-muted-foreground">{r.method}</span> {r.route}
                      </TableCell>
                      <TableCell
                        className={cn("text-right font-mono text-xs tabular-nums", r.budgetLeftPercent < 0 && "text-destructive")}
                      >
                        {budgetText(r.budgetLeftPercent)}
                      </TableCell>
                      <TableCell className={cn("text-right font-mono text-xs tabular-nums", r.alert && "text-destructive")}>
                        {burnText(r.burn1h)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
