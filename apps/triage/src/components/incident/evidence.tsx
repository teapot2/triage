"use client";

import {
  ChartLineIcon,
  DatabaseIcon,
  FileCodeIcon,
  GitCommitHorizontalIcon,
  type LucideIcon,
  ScrollTextIcon,
  WaypointsIcon,
} from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Evidence, EvidenceKind } from "@/lib/investigation/schema";
import { cn } from "@/lib/utils";
import { formatDateTime, formatDuration } from "./format";
import { MetricChart } from "./metric-chart";
import { LogLevelBadge } from "./outcome-badges";
import { evidenceTitle, metricLabel } from "./metric-labels";

export const evidenceIcons: Record<EvidenceKind, LucideIcon> = {
  log: ScrollTextIcon,
  span: WaypointsIcon,
  metric: ChartLineIcon,
  db: DatabaseIcon,
  source: FileCodeIcon,
  commit: GitCommitHorizontalIcon,
};

interface EvidenceContextValue {
  byId: Map<string, Evidence>;
  numberOf: Map<string, number>;
  open: (id: string) => void;
  // The evidence opened last, until a few seconds after its panel closes:
  // the timeline highlights its source so it's in view when the panel closes.
  focused: string | null;
  // Whether the evidence panel is open; the highlight flashes once it closes.
  panelOpen: boolean;
}

const EvidenceContext = createContext<EvidenceContextValue | null>(null);

export function useEvidence() {
  const ctx = useContext(EvidenceContext);
  if (!ctx) throw new Error("useEvidence must be used within EvidenceProvider");
  return ctx;
}

export function EvidenceProvider({
  evidence,
  order = [],
  children,
}: {
  evidence: Evidence[];
  // IDs to number first (in page order); the rest follow in collection order.
  order?: string[];
  children: ReactNode;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const byId = useMemo(() => new Map(evidence.map((e) => [e.id, e])), [evidence]);
  const numberOf = useMemo(() => {
    const ids = [...new Set([...order.filter((id) => byId.has(id)), ...evidence.map((e) => e.id)])];
    return new Map(ids.map((id, i) => [id, i + 1]));
  }, [order, evidence, byId]);
  const [focused, setFocused] = useState<string | null>(null);
  const panelOpen = openId !== null;
  useEffect(() => {
    if (!focused || panelOpen) return;
    const timer = setTimeout(() => setFocused(null), 3000);
    return () => clearTimeout(timer);
  }, [focused, panelOpen]);
  const value = useMemo(
    () => ({
      byId,
      numberOf,
      focused,
      panelOpen,
      open: (id: string) => {
        setOpenId(id);
        setFocused(id);
      },
    }),
    [byId, numberOf, focused, panelOpen],
  );
  const selected = openId ? byId.get(openId) : undefined;

  return (
    <EvidenceContext.Provider value={value}>
      {children}
      <Sheet open={selected !== undefined} onOpenChange={(open) => !open && setOpenId(null)}>
        <SheetContent className="w-full gap-0 sm:max-w-2xl">
          {selected && <EvidenceDetail evidence={selected} />}
        </SheetContent>
      </Sheet>
    </EvidenceContext.Provider>
  );
}

// A numbered citation, like a footnote. Hover shows what it is; click opens
// the raw evidence. Unknown IDs render as a struck "?": the verifier could
// not find the evidence, so the claim citing it is not trusted.
export function Citation({ id }: { id: string }) {
  const { byId, numberOf, open } = useEvidence();
  const evidence = byId.get(id);

  if (!evidence) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex h-4 min-w-4 items-center justify-center rounded bg-destructive/15 px-1 align-baseline font-mono text-[10px] text-destructive line-through">
            ?
          </span>
        </TooltipTrigger>
        <TooltipContent>{id}: no tool returned this evidence. The claim is not verified.</TooltipContent>
      </Tooltip>
    );
  }

  const Icon = evidenceIcons[evidence.kind];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => open(id)}
          className="inline-flex h-4 min-w-4 items-center justify-center rounded bg-muted px-1 align-baseline font-mono text-[10px] text-muted-foreground tabular-nums transition-colors hover:bg-primary hover:text-primary-foreground"
        >
          {numberOf.get(id)}
        </button>
      </TooltipTrigger>
      <TooltipContent className="flex max-w-xs items-start gap-1.5">
        <Icon className="mt-0.5 size-3 shrink-0" />
        <span>{evidenceTitle(evidence)}</span>
      </TooltipContent>
    </Tooltip>
  );
}

export function Citations({ ids, className }: { ids: string[]; className?: string }) {
  return (
    <span className={cn("inline-flex flex-wrap gap-0.5", className)}>
      {ids.map((id) => (
        <Citation key={id} id={id} />
      ))}
    </span>
  );
}

function EvidenceDetail({ evidence }: { evidence: Evidence }) {
  const Icon = evidenceIcons[evidence.kind];
  return (
    <>
      <SheetHeader className="border-b">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pr-8 text-muted-foreground text-xs">
          <Icon className="size-3.5" />
          <span className="font-mono">{evidence.id}</span>
          <span>·</span>
          <span className="font-mono">{evidence.tool}</span>
          {evidence.observedAt && (
            <>
              <span>·</span>
              <span>{formatDateTime(evidence.observedAt)}</span>
            </>
          )}
        </div>
        <SheetTitle>{evidenceTitle(evidence)}</SheetTitle>
        <SheetDescription className="sr-only">Raw evidence returned by {evidence.tool}</SheetDescription>
      </SheetHeader>
      <div className="flex flex-col gap-4 overflow-y-auto p-4 text-sm">
        <EvidenceBody evidence={evidence} />
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs uppercase tracking-wide">{label}</span>
      <div>{children}</div>
    </div>
  );
}

function EvidenceBody({ evidence }: { evidence: Evidence }) {
  switch (evidence.kind) {
    case "log":
      return (
        <>
          <div className="flex gap-2">
            <LogLevelBadge level={evidence.level} />
            <Badge variant="outline">{evidence.service}</Badge>
            {evidence.count && <Badge variant="outline">{evidence.count} occurrences</Badge>}
          </div>
          <pre className="whitespace-pre-wrap rounded-md border bg-muted/40 p-3 font-mono text-xs">
            {evidence.message}
          </pre>
          {evidence.traceId && (
            <Field label="Trace">
              <span className="font-mono text-xs">{evidence.traceId}</span>
            </Field>
          )}
        </>
      );
    case "span":
      return (
        <>
          <div className="flex gap-2">
            <Badge variant={evidence.status === "error" ? "destructive" : "secondary"}>{evidence.status}</Badge>
            <Badge variant="outline">{evidence.service}</Badge>
            <Badge variant="outline">{formatDuration(evidence.durationMs)}</Badge>
          </div>
          <Field label="Span">
            <span className="font-mono">{evidence.name}</span>
          </Field>
          <Field label="Trace">
            <span className="font-mono text-xs">{evidence.traceId}</span>
          </Field>
          <Table>
            <TableBody>
              {Object.entries(evidence.attributes).map(([key, value]) => (
                <TableRow key={key}>
                  <TableCell className="font-mono text-muted-foreground text-xs">{key}</TableCell>
                  <TableCell className="font-mono text-xs">{String(value)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      );
    case "metric":
      return (
        <>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Baseline">
              <span className="font-mono">
                {evidence.baseline} {evidence.unit}
              </span>
            </Field>
            <Field label="Observed">
              <span className="font-mono">
                {evidence.observed} {evidence.unit}
              </span>
            </Field>
          </div>
          <MetricChart series={evidence.series} label={metricLabel(evidence.metric)} unit={evidence.unit} className="h-48" />
          <span className="font-mono text-muted-foreground text-xs">{evidence.metric}</span>
        </>
      );
    case "db": {
      const columns = Object.keys(evidence.rows[0] ?? {});
      return (
        <>
          <CodeBlock code={evidence.query} language="sql" />
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((c) => (
                  <TableHead key={c} className="font-mono text-xs">
                    {c}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {evidence.rows.map((row, i) => (
                <TableRow key={i}>
                  {columns.map((c) => (
                    <TableCell key={c} className="font-mono text-xs">
                      {String(row[c])}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      );
    }
    case "source":
      return (
        <>
          <span className="font-mono text-muted-foreground text-xs">
            {evidence.file}:{evidence.startLine}
          </span>
          <CodeBlock code={evidence.code} language="typescript" showLineNumbers />
        </>
      );
    case "commit":
      return (
        <>
          <Field label="Commit">
            <span className="font-mono">{evidence.sha}</span> by {evidence.author}
          </Field>
          <Field label="Message">{evidence.message}</Field>
          <Field label="Files">
            <ul className="flex flex-col gap-1 font-mono text-xs">
              {evidence.files.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </Field>
        </>
      );
  }
}
