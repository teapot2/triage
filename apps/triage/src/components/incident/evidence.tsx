"use client";

import {
  ChartLineIcon,
  DatabaseIcon,
  FileCodeIcon,
  GitCommitHorizontalIcon,
  type LucideIcon,
  ScrollTextIcon,
  WaypointsIcon,
  XIcon,
} from "lucide-react";
import {
  createContext,
  type ElementType,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockWrapButton,
} from "@/components/ai-elements/code-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Timestamp } from "@/components/timestamp";
import { formatDuration } from "./format";
import { EvidenceMetricChart } from "./incident-export";
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
  // the timeline highlights its source, beside the docked panel or in view
  // when the sheet closes.
  focused: string | null;
  // Whether the evidence panel is open.
  panelOpen: boolean;
  // Whether it's open as a sheet over the page, hiding it; the highlight
  // flashes once the page is visible again.
  covered: boolean;
}

// Wide enough to keep the evidence beside the report instead of over it.
// Narrower, the report would be squeezed to a column, so it's a sheet.
const DOCK_QUERY = "(min-width: 1280px)";

function subscribeDock(onChange: () => void) {
  const mql = window.matchMedia(DOCK_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

// The server snapshot is the sheet; nothing is open on the first render.
function useDocked() {
  return useSyncExternalStore(subscribeDock, () => window.matchMedia(DOCK_QUERY).matches, () => false);
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
  const docked = useDocked();
  useEffect(() => {
    if (!focused || panelOpen) return;
    const timer = setTimeout(() => setFocused(null), 3000);
    return () => clearTimeout(timer);
  }, [focused, panelOpen]);

  // The sheet is a dialog and handles focus itself. The docked panel isn't,
  // so it takes focus when it opens or changes, and gives it back to
  // whatever opened it when it closes.
  const opener = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const close = useCallback(() => {
    setOpenId(null);
    opener.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (docked && openId) panelRef.current?.focus({ preventScroll: true });
  }, [docked, openId]);
  useEffect(() => {
    if (!docked || !panelOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // A dialog over the page (the search palette, a confirm) closes first.
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return;
      close();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [docked, panelOpen, close]);

  const value = useMemo(
    () => ({
      byId,
      numberOf,
      focused,
      panelOpen,
      covered: panelOpen && !docked,
      open: (id: string) => {
        if (document.activeElement instanceof HTMLElement) opener.current = document.activeElement;
        setOpenId(id);
        setFocused(id);
      },
    }),
    [byId, numberOf, focused, panelOpen, docked],
  );
  const selected = openId ? byId.get(openId) : undefined;

  // The wrapper is always there, so opening the docked panel never remounts
  // the page beside it.
  return (
    <EvidenceContext.Provider value={value}>
      <div className="flex min-w-0 flex-1">
        <div className="min-w-0 flex-1">{children}</div>
        {docked && selected && (
          <aside
            ref={panelRef}
            tabIndex={-1}
            aria-label="Evidence"
            className="sticky top-0 flex h-svh w-md shrink-0 flex-col self-start border-l bg-background text-sm outline-none fade-in-0 slide-in-from-right-4 animate-in duration-200 ease-out motion-reduce:animate-none 2xl:w-xl"
          >
            <EvidenceDetail evidence={selected} docked />
            <Button variant="ghost" size="icon-sm" onClick={close} className="absolute top-3 right-3">
              <XIcon />
              <span className="sr-only">Close</span>
            </Button>
          </aside>
        )}
      </div>
      {!docked && (
        <Sheet open={selected !== undefined} onOpenChange={(open) => !open && setOpenId(null)}>
          <SheetContent className="w-full gap-0 sm:max-w-2xl">
            {selected && <EvidenceDetail evidence={selected} docked={false} />}
          </SheetContent>
        </Sheet>
      )}
    </EvidenceContext.Provider>
  );
}

// A numbered citation, like a footnote. Hover shows what it is; click opens
// the raw evidence. Unknown IDs render as a struck "?": the verifier could
// not find the evidence, so the claim citing it is not trusted. The tooltips
// aren't hoverable: citations sit side by side under a tooltip wider than
// each, and a hoverable one stays open while the pointer crosses to the next
// citation, which then can't open its own.
export function Citation({ id }: { id: string }) {
  const { byId, numberOf, open } = useEvidence();
  const evidence = byId.get(id);

  if (!evidence) {
    return (
      <Tooltip disableHoverableContent>
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
    <Tooltip disableHoverableContent>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => open(id)}
          className="inline-flex h-4 min-w-4 items-center justify-center rounded bg-muted px-1 align-baseline font-mono text-[10px] text-muted-foreground tabular-nums transition-colors hover:bg-primary hover:text-primary-foreground print:h-auto print:min-w-0 print:rounded-none print:bg-transparent print:px-0 print:align-super print:text-foreground print:before:content-['['] print:after:content-[']']"
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
    // On paper, plain footnote numbers: [3][7].
    <span className={cn("inline-flex flex-wrap gap-0.5 print:gap-0", className)}>
      {ids.map((id) => (
        <Citation key={id} id={id} />
      ))}
    </span>
  );
}

function EvidenceDetail({ evidence, docked }: { evidence: Evidence; docked: boolean }) {
  const Icon = evidenceIcons[evidence.kind];
  // In the sheet these are the dialog's title and description; docked
  // beside the page there's no dialog around them, so they're plain elements.
  const Title: ElementType = docked ? "h2" : SheetTitle;
  const Description: ElementType = docked ? "p" : SheetDescription;
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
              <Timestamp date={evidence.observedAt} />
            </>
          )}
        </div>
        <Title className="font-heading font-medium text-base text-foreground">{evidenceTitle(evidence)}</Title>
        <Description className="sr-only">Raw evidence returned by {evidence.tool}</Description>
      </SheetHeader>
      {/* Blocks keep their full height and the body scrolls. Without
          shrink-0, a block that clips its overflow (the code block does)
          shrinks to the panel's height and cuts its content off. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 text-sm *:shrink-0">
        <EvidenceBody evidence={evidence} />
      </div>
    </>
  );
}

// What the code is (a file, or the query language) on the left; wrapping and
// copying on the right. Code is the evidence most likely to run wider than
// the panel, so wrapping is offered on every block.
function CodeHeader({ label }: { label: string }) {
  return (
    <CodeBlockHeader className="gap-2 py-1">
      <CodeBlockTitle className="min-w-0">
        <CodeBlockFilename className="truncate">{label}</CodeBlockFilename>
      </CodeBlockTitle>
      <CodeBlockActions className="gap-0">
        <CodeBlockWrapButton className="size-7" />
        <CodeBlockCopyButton className="size-7" />
      </CodeBlockActions>
    </CodeBlockHeader>
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
                  {/* Values (error messages, URLs) wrap instead of scrolling the table. */}
                  <TableCell className="whitespace-normal break-all font-mono text-xs">{String(value)}</TableCell>
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
          <EvidenceMetricChart series={evidence.series} label={metricLabel(evidence.metric)} unit={evidence.unit} className="h-48" />
          {/* Metric names run long with labels and have no spaces; break
              anywhere rather than scroll the panel sideways. */}
          <span className="break-all font-mono text-muted-foreground text-xs">{evidence.metric}</span>
        </>
      );
    case "db": {
      const columns = Object.keys(evidence.rows[0] ?? {});
      return (
        <>
          <CodeBlock code={evidence.query} language="sql">
            <CodeHeader label="SQL" />
          </CodeBlock>
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
        <CodeBlock code={evidence.code} language="typescript" showLineNumbers>
          <CodeHeader label={`${evidence.file}:${evidence.startLine}`} />
        </CodeBlock>
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
