"use client";

import { ChevronRightIcon, CircleCheckIcon, CircleHelpIcon, CircleXIcon, CrosshairIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import { useCountUp } from "@/hooks/use-count-up";
import type { Claim, Evidence, Hypothesis, InvestigationReport } from "@/lib/investigation/schema";
import { cn } from "@/lib/utils";
import { Citations } from "./evidence";
import { formatPercent } from "./format";
import type { ChartMarker } from "./metric-chart";
import { collapseMotion } from "./motion";

// The hypotheses that didn't win, in the order AlsoConsidered shows them:
// the ones still possible first, then the ruled-out ones, each by
// confidence. citationOrder follows it, so footnotes number down the page.
function otherHypotheses(report: InvestigationReport): Hypothesis[] {
  const { verdict } = report;
  const ruledOut = (h: Hypothesis) => Number(h.status === "rejected");
  return report.hypotheses
    .filter((h) => verdict.kind !== "root_cause" || h.id !== verdict.hypothesisId)
    .sort((a, b) => ruledOut(a) - ruledOut(b) || b.confidence - a.confidence);
}

// Evidence IDs in the order the panel shows them, so citations number like
// footnotes: 1, 2, 3 down the page.
export function citationOrder(report: InvestigationReport): string[] {
  const { verdict } = report;
  const claims: Claim[] = [];
  if (verdict.kind === "root_cause") {
    const h = report.hypotheses.find((x) => x.id === verdict.hypothesisId);
    if (h) claims.push(h.causalChain.symptom, h.causalChain.propagation, h.causalChain.rootCause);
  }
  if (verdict.kind === "healthy") claims.push(verdict.rationale);
  for (const h of otherHypotheses(report)) claims.push(h.rejectedBecause ?? h.causalChain.rootCause);
  return [...new Set(claims.flatMap((c) => c.evidenceIds))];
}

// Deploys the diagnosis points at, to mark on the alert chart. Only the ones
// its causal chain cites: any other deploy on the chart would suggest a
// cause the agent didn't find.
export function citedDeploys(report: InvestigationReport, evidence: Evidence[]): ChartMarker[] {
  const { verdict } = report;
  if (verdict.kind !== "root_cause") return [];
  const h = report.hypotheses.find((x) => x.id === verdict.hypothesisId);
  if (!h) return [];
  const { symptom, propagation, rootCause } = h.causalChain;
  const ids = new Set([symptom, propagation, rootCause].flatMap((c) => c.evidenceIds));
  const shas = new Set(evidence.flatMap((e) => (e.kind === "commit" && ids.has(e.id) ? [e.sha] : [])));
  const markers = new Map<string, ChartMarker>();
  for (const e of evidence) {
    if (e.kind === "commit" && e.tool === "deploy_history" && e.observedAt && shas.has(e.sha)) {
      markers.set(e.sha, { t: e.observedAt, label: `${e.sha.slice(0, 7)} deployed` });
    }
  }
  return [...markers.values()];
}

// The answer, as one card: the verdict and how sure the agent is on top,
// its plain-English summary below, and the argument behind it folded into
// the footer. Reports from before the summary existed fall back to the
// verdict's own claim.
export function VerdictCard({
  report,
  unknownEvidenceIds,
  className,
}: {
  report: InvestigationReport;
  unknownEvidenceIds: string[];
  className?: string;
}) {
  const { verdict } = report;
  const leading =
    verdict.kind === "root_cause" ? report.hypotheses.find((h) => h.id === verdict.hypothesisId) : undefined;
  const others = otherHypotheses(report);
  const ruledOut = others.filter((h) => h.status === "rejected").length;
  const rationale = verdict.kind === "healthy" ? verdict.rationale : undefined;
  const hasReasoning = Boolean(leading || rationale || others.length > 0);

  let label: ReactNode;
  let title: string;
  let aside: ReactNode;
  let body: ReactNode;
  if (leading) {
    label = (
      <>
        <CrosshairIcon className="size-3.5" />
        Root cause
      </>
    );
    title = leading.title;
    aside = <Confidence value={leading.confidence} />;
    body = report.summary ?? leading.causalChain.rootCause.text;
  } else if (verdict.kind === "healthy") {
    label = "Verdict";
    title = "No issue found";
    aside = (
      <span className="flex items-center gap-1.5 text-sm text-success">
        <CircleCheckIcon className="size-4" />
        Healthy
      </span>
    );
    body = report.summary ?? verdict.rationale.text;
  } else {
    label = "Verdict";
    title = "Not enough evidence";
    aside = (
      <span className="flex items-center gap-1.5 text-sm text-warning">
        <CircleHelpIcon className="size-4" />
        Inconclusive
      </span>
    );
    body = (
      <>
        {report.summary && <span className="block">{report.summary}</span>}
        {verdict.kind === "inconclusive" && <span className="block">Missing: {verdict.missing.join(", ")}</span>}
      </>
    );
  }

  return (
    <Collapsible className={cn("group/why rounded-lg border", className)}>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="flex items-center gap-1.5 text-muted-foreground text-xs">{label}</span>
            <h2 className="font-heading font-medium text-lg leading-snug">{title}</h2>
          </div>
          <div className="shrink-0 sm:pt-0.5">{aside}</div>
        </div>
        <p className="text-muted-foreground text-sm leading-relaxed">{body}</p>
      </div>

      {hasReasoning && (
        <>
          <CollapsibleTrigger className="flex w-full items-center gap-1 border-t px-4 py-2.5 text-muted-foreground text-sm transition-colors hover:text-foreground">
            <ChevronRightIcon className="size-4 transition-[rotate] duration-200 group-data-[state=open]/why:rotate-90 motion-reduce:transition-none" />
            Why we think this
            {others.length > 0 && (
              <span className="ml-auto text-xs">
                {ruledOut > 0
                  ? `Ruled out ${ruledOut} other ${ruledOut === 1 ? "cause" : "causes"}`
                  : `${others.length} other ${others.length === 1 ? "cause" : "causes"} considered`}
              </span>
            )}
          </CollapsibleTrigger>
          <CollapsibleContent className={collapseMotion}>
            <Reasoning
              report={report}
              leading={leading}
              rationale={rationale}
              others={others}
              unknownEvidenceIds={unknownEvidenceIds}
            />
          </CollapsibleContent>
        </>
      )}
    </Collapsible>
  );
}

// How sure the agent is, as a number over a thin bar. The number counts up
// as the bar fills.
function Confidence({ value }: { value: number }) {
  const shown = useCountUp(value, { duration: 700, fromZero: true });
  return (
    <div className="flex w-32 flex-col gap-1.5 sm:items-end">
      <span className="text-sm">
        <span className="font-medium tabular-nums">{formatPercent(shown)}</span>{" "}
        <span className="text-muted-foreground">confidence</span>
      </span>
      <Progress
        value={Math.round(value * 100)}
        aria-label="Confidence"
        className="w-full *:data-[slot=progress-indicator]:animate-progress-fill motion-reduce:*:data-[slot=progress-indicator]:animate-none"
      />
    </div>
  );
}

// The argument behind the verdict: how the symptom led to the root cause,
// each step with its citations, then what was ruled out.
function Reasoning({
  report,
  leading,
  rationale,
  others,
  unknownEvidenceIds,
}: {
  report: InvestigationReport;
  leading?: Hypothesis;
  rationale?: Claim;
  others: Hypothesis[];
  unknownEvidenceIds: string[];
}) {
  const unverified = (c: Claim) => c.evidenceIds.some((id) => unknownEvidenceIds.includes(id));
  // Without a summary, the verdict's own claim is already the card's
  // sentence, so here it only needs its evidence.
  const claimShown = report.summary === undefined;

  return (
    <div className="flex flex-col gap-5 px-4 pt-1 pb-4 pl-9">
      {leading && <Chain hypothesis={leading} unverified={unverified} claimShown={claimShown} />}
      {rationale &&
        (claimShown ? (
          <ConfirmedBy claim={rationale} struck={unverified(rationale)} />
        ) : (
          <ClaimText claim={rationale} struck={unverified(rationale)} />
        ))}
      <AlsoConsidered hypotheses={others} unverified={unverified} />
    </div>
  );
}

// The hypotheses that didn't win, part of why the verdict is trustworthy:
// grouped by status, the ones still possible first since they're what's
// left to check. Each is its title, then the reason under it, beside an
// icon in the chain's marker column.
const consideredGroups = [
  { label: "Still possible", icon: CircleHelpIcon, iconClass: "text-warning", rejected: false },
  { label: "Ruled out", icon: CircleXIcon, iconClass: "text-muted-foreground", rejected: true },
];

function AlsoConsidered({
  hypotheses,
  unverified,
}: {
  hypotheses: Hypothesis[];
  unverified: (c: Claim) => boolean;
}) {
  if (hypotheses.length === 0) return null;
  return (
    <div className="flex flex-col gap-4 border-t pt-4">
      {consideredGroups.map(({ label, icon: Icon, iconClass, rejected }) => {
        const items = hypotheses.filter((h) => (h.status === "rejected") === rejected);
        if (items.length === 0) return null;
        return (
          <div key={label} className="flex flex-col gap-2.5">
            <span className="text-muted-foreground text-xs">
              {label} · {items.length}
            </span>
            <ul className="flex flex-col gap-3">
              {items.map((h) => {
                const reason = h.rejectedBecause ?? h.causalChain.rootCause;
                // The agent sometimes leads with "Rejected:", which the heading already says.
                const text = reason.text.replace(/^rejected:\s*/i, "");
                return (
                  <li key={h.id} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2">
                    <Icon className={cn("mt-0.5 size-4", iconClass)} />
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium text-sm">{h.title}</span>
                      <ClaimText claim={{ ...reason, text }} struck={unverified(reason)} className="text-muted-foreground" />
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

// Symptom -> propagation -> root cause. When the root cause's sentence is
// already the verdict above, its step only shows the evidence for it.
function Chain({
  hypothesis: h,
  unverified,
  claimShown,
}: {
  hypothesis: Hypothesis;
  unverified: (c: Claim) => boolean;
  claimShown: boolean;
}) {
  const { rootCause } = h.causalChain;
  const chain: [string, ReactNode][] = [
    ["Symptom", <ClaimText key="s" claim={h.causalChain.symptom} struck={unverified(h.causalChain.symptom)} />],
    [
      "Propagation",
      <ClaimText key="p" claim={h.causalChain.propagation} struck={unverified(h.causalChain.propagation)} />,
    ],
    [
      "Root cause",
      claimShown ? (
        <ConfirmedBy key="r" claim={rootCause} struck={unverified(rootCause)} />
      ) : (
        <ClaimText key="r" claim={rootCause} struck={unverified(rootCause)} />
      ),
    ],
  ];

  return (
    <ol className="flex flex-col">
      {chain.map(([label, body], i) => (
        <li key={label} className="relative flex gap-3 pb-3 last:pb-0">
          <div className="flex flex-col items-center">
            <span
              className={cn(
                "mt-1.5 size-2 shrink-0 rounded-full",
                i === chain.length - 1 ? "bg-destructive" : "bg-muted-foreground/50",
              )}
            />
            {i < chain.length - 1 && <span className="mt-1 w-px flex-1 bg-border" />}
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground text-xs">{label}</span>
            {body}
          </div>
        </li>
      ))}
    </ol>
  );
}

function ConfirmedBy({ claim, struck }: { claim: Claim; struck: boolean }) {
  return (
    <span className={cn("flex items-center gap-1.5 text-muted-foreground text-sm", struck && "line-through")}>
      Confirmed by <Citations ids={claim.evidenceIds} />
    </span>
  );
}

function ClaimText({ claim, struck, className }: { claim: Claim; struck: boolean; className?: string }) {
  return (
    <span className={cn("block text-sm leading-relaxed", struck && "text-muted-foreground line-through", className)}>
      {claim.text} <Citations ids={claim.evidenceIds} />
    </span>
  );
}
