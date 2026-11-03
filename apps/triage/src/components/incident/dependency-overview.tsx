"use client";

import { ArrowRightIcon, LoaderCircleIcon, ShieldAlertIcon, WrenchIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Timestamp } from "@/components/timestamp";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { DependencyAdvisory, Exposure, Incident } from "@/lib/investigation/schema";
import { cn } from "@/lib/utils";
import { AdvisoryCard } from "./dependency-card";
import { exposureLabels } from "./diagnosis-panel";
import { Citations } from "./evidence";
import { FixProgress, FixProof } from "./fix-panel";
import { type Step, StepList } from "./progress-steps";
import { VerificationLine } from "./verification";

// A dependency incident's Overview, in the order its reader asks: what is
// vulnerable (the advisory), does it affect us (the exposure), and what is
// being done (the bump, its PR, the audit that confirms it). Each fact is
// said once. What the other incidents' Overview adds stays off it: the
// root-cause card's confidence and ruled-out causes (Triage builds them
// around the exposure, so they say nothing more), the mitigation card (a
// dependency never has one) and the alert chart (a 1 per audit). The Fix,
// Investigation and Ask tabs keep every detail.

export function DependencyOverview({
  incident,
  advisory,
  unknownEvidenceIds,
  onSection,
}: {
  incident: Incident;
  advisory: DependencyAdvisory;
  unknownEvidenceIds: string[];
  onSection: (id: "fix" | "investigation") => void;
}) {
  return (
    <>
      <AdvisoryCard advisory={advisory} />
      <ExposureCard incident={incident} advisory={advisory} unknownEvidenceIds={unknownEvidenceIds} onSection={onSection} />
      <ProgressCard incident={incident} advisory={advisory} onSection={onSection} />
    </>
  );
}

function ExposureCard({
  incident,
  advisory,
  unknownEvidenceIds,
  onSection,
}: {
  incident: Incident;
  advisory: DependencyAdvisory;
  unknownEvidenceIds: string[];
  onSection: (id: "investigation") => void;
}) {
  const exposure = incident.report?.exposure;
  let body: ReactNode;
  if (exposure) {
    // The model's reason, with the files it cites; struck through when it
    // cites evidence the record doesn't have.
    const struck = exposure.rationale.evidenceIds.some((id) => unknownEvidenceIds.includes(id));
    body = (
      <p className={cn("text-sm leading-relaxed", struck && "text-muted-foreground line-through")}>
        {exposure.rationale.text} <Citations ids={exposure.rationale.evidenceIds} />
      </p>
    );
  } else if (incident.status === "investigating") {
    body = (
      <div className="flex flex-col items-start gap-2">
        <p className="flex items-center gap-2 text-muted-foreground text-sm">
          <LoaderCircleIcon className="size-4 shrink-0 animate-spin" />
          Reading {incident.service}&apos;s code for where it uses {advisory.package}.
        </p>
        <Button variant="outline" size="sm" onClick={() => onSection("investigation")}>
          Watch the investigation <ArrowRightIcon />
        </Button>
      </div>
    );
  } else body = <p className="text-muted-foreground text-sm">No exposure verdict: the check didn&apos;t finish.</p>;
  // The verdict at the right of the label row, where the advisory card puts
  // its severity: the card's answer where the eye looks for it.
  return (
    <section className="flex flex-col gap-2 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <ShieldAlertIcon className="size-3.5" aria-hidden />
          Exposure
        </span>
        {exposure && <ExposureBadge exposure={exposure} />}
      </div>
      {body}
    </section>
  );
}

// The verdict as a badge, what it means on hover.
function ExposureBadge({ exposure }: { exposure: Exposure }) {
  const { label, tone, text } = exposureLabels[exposure.verdict] ?? { label: exposure.verdict, tone: "muted" as const, text: "" };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-default">
          <StatusBadge tone={tone}>{label}</StatusBadge>
        </span>
      </TooltipTrigger>
      {text && <TooltipContent>{text}</TooltipContent>}
    </Tooltip>
  );
}

const prNumber = (url: string) => url.match(/\/pull\/(\d+)/)?.[1];

// The fix as three steps: the bump, its PR, and the audit that confirms it.
// A finished step is one line; the step the incident is on now also shows
// what it's doing or waiting for.
function ProgressCard({
  incident,
  advisory,
  onSection,
}: {
  incident: Incident;
  advisory: DependencyAdvisory;
  onSection: (id: "fix") => void;
}) {
  const steps = progressSteps(incident, advisory, onSection);
  if (!steps) return null;
  return (
    <section className="flex flex-col gap-3 rounded-lg border p-4">
      <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <WrenchIcon className="size-3.5" aria-hidden />
        Fix
      </span>
      <StepList steps={steps} />
    </section>
  );
}

function progressSteps(incident: Incident, advisory: DependencyAdvisory, onSection: (id: "fix") => void): Step[] | undefined {
  const { fix, fixRun, approval, verification: v, validation } = incident;
  // Nothing to show until there's a fix to talk about, or the advisory
  // went away before one.
  if (!fixRun && !fix && !v && incident.status !== "resolved") return undefined;

  // 1. The bump: being written and proven, proven, or none.
  let bump: Step;
  if (fix?.bump && fixRun?.status !== "writing" && fixRun?.status !== "testing") {
    bump = {
      title: `Bump ${fix.bump.package} ${fix.bump.from} → ${fix.bump.to}`,
      state: "done",
      summary: (
        <Tooltip>
          <TooltipTrigger className="cursor-default underline decoration-dotted underline-offset-2">proven in a sandbox</TooltipTrigger>
          <TooltipContent>
            <FixProof validation={validation} bump />
          </TooltipContent>
        </Tooltip>
      ),
    };
  } else if (fixRun && (fixRun.status === "failed" || fixRun.status === "declined")) {
    bump = {
      title: fixRun.status === "declined" ? "No bump proposed" : "No proven bump",
      state: "failed",
      detail: <p className="text-muted-foreground text-sm">{fixRun.declinedBecause ?? fixRun.error ?? "The sandbox checks didn't pass."}</p>,
    };
  } else if (fixRun) {
    bump = { title: `Bump ${advisory.package}`, state: "current", detail: <FixProgress fixRun={fixRun} dependency /> };
  } else {
    bump = { title: `Bump ${advisory.package}`, state: "todo" };
  }

  // 2. The PR: waiting for approval, opening, open, merged, or denied.
  let pr: Step;
  const number = approval?.prUrl ? prNumber(approval.prUrl) : undefined;
  const prLabel = number ? `PR #${number}` : "The PR";
  if (approval?.state === "pending" && bump.state === "done") {
    // The one step that needs a person: the proof they decide on, in full.
    pr = {
      title: "Waiting for your approval",
      state: "waiting",
      summary: "Approve fix above opens a draft PR",
      detail: (
        <>
          <FixProof validation={validation} bump />
          <Button variant="outline" size="sm" className="self-start" onClick={() => onSection("fix")}>
            Review the fix <ArrowRightIcon />
          </Button>
        </>
      ),
    };
  } else if (approval?.state === "denied") {
    pr = { title: "Denied", state: "failed", summary: approval.reason };
  } else if (approval?.prState === "opening") {
    pr = { title: "Opening the PR", state: "current" };
  } else if (approval?.prState === "failed") {
    pr = { title: "The PR didn't open", state: "failed", summary: approval.prError?.split("\n")[0] };
  } else if (approval?.prMergedAt) {
    pr = { title: `${prLabel} merged`, state: "done", summary: <Timestamp date={approval.prMergedAt} /> };
  } else if (approval?.prState === "opened") {
    pr = { title: `${prLabel} open`, state: "waiting", summary: "waiting for it to be merged" };
  } else {
    pr = { title: "Open a PR", state: "todo" };
  }

  // 3. The audit that confirms it.
  let verified: Step;
  if (v?.after === "dependencies" && v.status === "resolved") {
    verified = {
      title: "Verified",
      state: "done",
      summary: v.note ?? (
        <>
          the audit <Timestamp date={v.finishedAt ?? v.checkedAt ?? v.startedAt} /> no longer finds {advisory.advisoryId}
        </>
      ),
    };
  } else if (incident.status === "resolved") {
    verified = { title: "Resolved", state: "done", summary: incident.resolvedAt && <Timestamp date={incident.resolvedAt} /> };
  } else if (v?.status === "verifying") {
    verified = {
      title: "Verifying",
      state: "current",
      summary: `waiting for an audit that no longer finds ${advisory.advisoryId}`,
      detail: v.note && <p className="text-muted-foreground text-xs">{v.note}</p>,
    };
  } else if (v && v.status !== "resolved") {
    // Stopped or breached: the line says why, with Verify again.
    verified = { title: "Verify", state: "failed", detail: <VerificationLine incident={incident} verification={v} /> };
  } else {
    verified = { title: "Verify", state: "todo", summary: "the first audit after the merge that no longer finds it resolves this" };
  }

  return [bump, pr, verified];
}
