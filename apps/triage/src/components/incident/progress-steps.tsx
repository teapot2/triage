import { CheckIcon, CircleIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// How something after the diagnosis is going, as a few steps, one line each:
// a mitigation (applied, recovered, verified) or a dependency fix (bump, PR,
// verified). A finished step is its title and a few words; the step it's on
// now can also show what it's doing or waiting for, and the ones ahead are
// grey.

// done: finished. current: Triage is working on it. waiting: a person has
// to act (approve, merge). failed: it stopped short. todo: not reached yet.
export type StepState = "done" | "current" | "waiting" | "failed" | "todo";

export type Step = { title: string; state: StepState; summary?: ReactNode; detail?: ReactNode };

export function StepList({ steps, className }: { steps: Step[]; className?: string }) {
  return (
    <ol className={cn("flex flex-col gap-3", className)}>
      {steps.map((s) => (
        <li key={s.title} className="flex gap-2.5">
          <StepIcon state={s.state} />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <p className={cn("text-sm", s.state === "todo" && "text-muted-foreground")}>
              <span className="font-medium">{s.title}</span>
              {s.summary && <span className="text-muted-foreground"> · {s.summary}</span>}
            </p>
            {s.detail}
          </div>
        </li>
      ))}
    </ol>
  );
}

function StepIcon({ state }: { state: StepState }) {
  const base = "mt-0.5 size-4 shrink-0";
  if (state === "done") return <CheckIcon className={cn(base, "text-success")} aria-label="Done" />;
  if (state === "current") {
    return <LoaderCircleIcon className={cn(base, "animate-spin text-muted-foreground motion-reduce:animate-none")} aria-label="In progress" />;
  }
  if (state === "failed") return <TriangleAlertIcon className={cn(base, "text-warning")} aria-label="Stopped" />;
  if (state === "waiting") return <CircleIcon className={cn(base, "fill-primary text-primary")} aria-label="Waiting on a person" />;
  return <CircleIcon className={cn(base, "text-muted-foreground/50")} aria-label="Not yet" />;
}
