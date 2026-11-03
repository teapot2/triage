"use client";

import { ChevronRightIcon, CircleHelpIcon, CircleXIcon, CrosshairIcon, InfoIcon, ShieldAlertIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { StatusBadge, type StatusTone } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCountUp } from "@/hooks/use-count-up";
import { otherHypotheses } from "@/lib/investigation/citations";
import { gradeHypothesis, gradeLabels, gradeTone } from "@/lib/investigation/confidence-grade";
import { rollupLabels, rollupTone, verdictOutcome } from "@/lib/investigation/outcome";
import type { Claim, Evidence, Exposure, Hypothesis, Incident, InvestigationReport } from "@/lib/investigation/schema";
import { cn } from "@/lib/utils";
import { Citations } from "./evidence";
import { formatPercent } from "./format";
import type { ChartMarker } from "./metric-chart";

export { citationOrder } from "@/lib/investigation/citations";

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
      const flag = e.sha.startsWith("config:") && e.sha.slice("config:".length);
      markers.set(e.sha, { t: e.observedAt, label: flag ? `${flag} turned on` : `${e.sha.slice(0, 7)} deployed` });
    }
  }
  return [...markers.values()];
}

// The answer, as one card: the verdict with one line on how far to trust
// it, and the model's own confidence beside it; its plain-English summary
// below, and the argument behind it folded into the footer. Reports from
// before the summary existed fall back to the verdict's own claim.
export function VerdictCard({
  incident,
  report,
  unknownEvidenceIds,
  className,
}: {
  incident: Incident;
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
  let trust: ReactNode;
  let body: ReactNode;
  if (leading) {
    label = (
      <>
        <CrosshairIcon className="size-3.5" />
        Root cause
      </>
    );
    title = leading.title;
    trust = <TrustLine hypothesis={leading} incident={incident} />;
    body = report.summary ?? leading.causalChain.rootCause.text;
  } else if (verdict.kind === "healthy") {
    label = "Verdict";
    title = "No issue found";
    trust = <StatusBadge tone="success">Healthy</StatusBadge>;
    body = report.summary ?? verdict.rationale.text;
  } else {
    label = "Verdict";
    title = "Not enough evidence";
    trust = <StatusBadge tone="warning">Inconclusive</StatusBadge>;
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
            {trust}
          </div>
          {leading && (
            <div className="shrink-0 sm:pt-0.5">
              <Confidence value={leading.confidence} />
            </div>
          )}
        </div>
        <p className="text-muted-foreground text-sm leading-relaxed">{body}</p>
        {report.exposure && (
          <ExposureLine
            exposure={report.exposure}
            struck={report.exposure.rationale.evidenceIds.some((id) => unknownEvidenceIds.includes(id))}
          />
        )}
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
          <CollapsibleContent>
            <Reasoning
              incident={incident}
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

// A dependency incident's exposure: whether the service's code reaches the
// vulnerable package, the question its severity hangs on, under the verdict
// as a line of its own with the files it cites.
export const exposureLabels: Record<Exposure["verdict"], { label: string; tone: StatusTone; text: string }> = {
  reachable: { label: "Reachable", tone: "destructive", text: "The service's code reaches the vulnerable package." },
  transitive_only: {
    label: "Transitive only",
    tone: "warning",
    text: "In the dependency tree, but nothing found leads from the service's code to it.",
  },
  not_reachable: { label: "Not reachable", tone: "success", text: "The code that would use it never runs in production." },
};

function ExposureLine({ exposure, struck }: { exposure: Exposure; struck: boolean }) {
  const { label, tone, text } = exposureLabels[exposure.verdict] ?? {
    label: exposure.verdict,
    tone: "muted" as const,
    text: "",
  };
  return (
    <div className="flex flex-col gap-1.5 rounded-md bg-muted/50 px-3 py-2.5">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <ShieldAlertIcon className="size-3.5" aria-hidden />
          Exposure
        </span>
        <StatusBadge tone={tone}>{label}</StatusBadge>
        {text && <span className="text-muted-foreground">{text}</span>}
      </span>
      <ClaimText claim={exposure.rationale} struck={struck} />
    </div>
  );
}

// How far the record bears the hypothesis out (confidence-grade.ts), as a
// small chip with why on hover. Worked out from the evidence and what came
// after, never from the model's say-so.
function GradeChip({ hypothesis, incident }: { hypothesis: Hypothesis; incident: Incident }) {
  const { grade, reason } = gradeHypothesis(hypothesis, incident);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-default">
          <StatusBadge tone={gradeTone[grade]}>{gradeLabels[grade]}</StatusBadge>
        </span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

// How far to trust the verdict, as one line under its title. The signal
// that says most leads, with its color: whether the diagnosis held
// (outcome.ts) once something checked it, else the grade the record gives
// it (confidence-grade.ts), then the grade muted when the outcome leads.
// The model's own confidence has its bar beside the title, so here it's
// only in the popover, with each signal's reason.
function TrustLine({ hypothesis, incident }: { hypothesis: Hypothesis; incident: Incident }) {
  const { grade, reason } = gradeHypothesis(hypothesis, incident);
  const outcome = verdictOutcome(incident);
  const held = outcome && outcome.rollup !== "unverified" ? outcome : undefined;
  const signal = held?.signals.find((s) => s.status !== "unknown");
  const confidence = formatPercent(hypothesis.confidence);
  const gradeLabel = gradeLabels[grade];
  const lead = held
    ? { tone: rollupTone[held.rollup], label: rollupLabels[held.rollup] }
    : { tone: gradeTone[grade], label: gradeLabel };
  const rest = held ? gradeLabel.charAt(0).toLowerCase() + gradeLabel.slice(1) : undefined;
  const rows = [
    ...(held
      ? [{ term: "What happened", label: rollupLabels[held.rollup], text: signal && signal.text.replace(/\.?$/, ".") }]
      : []),
    { term: "Evidence", label: gradeLabel, text: reason },
    { term: "Model", label: `${confidence} sure`, text: "By its own estimate." },
  ];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="-mx-1 flex w-fit flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-sm px-1 text-left text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <StatusBadge tone={lead.tone}>{lead.label}</StatusBadge>
          {rest && <span className="text-muted-foreground">· {rest}</span>}
          <InfoIcon aria-hidden className="size-3.5 text-muted-foreground" />
          <span className="sr-only">Why</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 max-w-[calc(100vw-2rem)] text-sm">
        <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5">
          {rows.map((r) => (
            <Fragment key={r.term}>
              <dt className="text-muted-foreground text-xs leading-5">{r.term}</dt>
              <dd className="leading-snug">
                <span className="font-medium">{r.label}.</span>
                {r.text && <span className="text-muted-foreground"> {r.text}</span>}
              </dd>
            </Fragment>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
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
  incident,
  report,
  leading,
  rationale,
  others,
  unknownEvidenceIds,
}: {
  incident: Incident;
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
      <AlsoConsidered incident={incident} hypotheses={others} unverified={unverified} />
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
  incident,
  hypotheses,
  unverified,
}: {
  incident: Incident;
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
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-medium text-sm">{h.title}</span>
                        {/* Every ruled-out row grades Contradicted, which its heading already says. */}
                        {!rejected && <GradeChip hypothesis={h} incident={incident} />}
                      </span>
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
