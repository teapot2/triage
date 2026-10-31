"use client";

import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// The pieces Triage's forms lay their fields out with: the sections for
// full pages (Watch's rules and endpoints), and the fields for any form,
// Settings' editors and dialogs included. AGENTS.md has the guidelines they
// follow.

// A titled group of fields, in a bordered box: two equal columns from small
// screens up, one on phones.
export function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium text-sm">{title}</h2>
      <div className="grid gap-x-4 gap-y-5 rounded-lg border p-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

// A titled box of FormRows, divided by lines: for things that repeat with
// the same fields, one row each, so their columns line up.
export function FormRows({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium text-sm">{title}</h2>
      <div className="divide-y rounded-lg border">{children}</div>
    </section>
  );
}

// One row of FormRows: its name, with a quiet note beside it, over its
// fields in the section's two columns.
export function FormRow({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 p-4">
      <h3 className="flex items-center gap-2 font-medium text-sm">
        {title}
        {aside && <span className="flex items-center gap-1.5 font-normal text-muted-foreground text-xs">{aside}</span>}
      </h3>
      <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2">{children}</div>
    </div>
  );
}

// What rarely changes, folded away under the sections, its values read out
// on one line while it's closed, like a Settings row. The form owns `open`,
// so Save can open it when a field inside is wrong.
export function FormAdvanced({
  summary,
  open,
  onOpenChange,
  children,
}: {
  summary: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="group/advanced rounded-lg border">
      <CollapsibleTrigger className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset">
        <ChevronRightIcon
          className="size-4 shrink-0 text-muted-foreground transition-[rotate] duration-200 group-data-[state=open]/advanced:rotate-90 motion-reduce:transition-none"
          aria-hidden
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium text-sm">Advanced</span>
          <span className="truncate text-muted-foreground text-xs">{summary}</span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-x-4 gap-y-5 px-4 pt-1 pb-4 sm:grid-cols-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// A labelled field, with a hint under it, or the error in its place. The
// hint or error has the id `${htmlFor}-message`, for the control's
// aria-describedby. `optional` says so beside the label, `count` shows the
// text's length against its limit at the right, and `wide` spans both
// columns. Without `htmlFor` the label names nothing, for a field whose
// control is a summary in place of an input.
export function FormField({
  label,
  htmlFor,
  hint,
  error,
  optional,
  count,
  wide,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string;
  optional?: boolean;
  count?: { length: number; max: number };
  wide?: boolean;
  children: ReactNode;
}) {
  const messageId = htmlFor && `${htmlFor}-message`;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", wide && "sm:col-span-2")}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={htmlFor} className="font-medium text-xs">
          {label}
          {optional && <span className="font-normal text-muted-foreground"> (optional)</span>}
        </label>
        {count && (
          <span className="text-muted-foreground text-xs tabular-nums" aria-hidden>
            {count.length}/{count.max}
          </span>
        )}
      </div>
      {children}
      {error ? (
        <span
          id={messageId}
          role="alert"
          className="break-words text-[color-mix(in_oklab,var(--destructive)_80%,black)] text-xs dark:text-destructive"
        >
          {error}
        </span>
      ) : (
        hint && (
          <span id={messageId} className="break-words text-muted-foreground text-xs">
            {hint}
          </span>
        )
      )}
    </div>
  );
}

// A number filling its cell, its unit, if it has one, shown inside at the
// right end. The browser's spin buttons are hidden; they'd sit on top of the
// unit.
export function NumberInput({
  id,
  unit,
  value,
  onChange,
  invalid,
  "aria-label": ariaLabel,
}: {
  id: string;
  unit?: string;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  "aria-label"?: string;
}) {
  return (
    <div className="relative min-w-0">
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid}
        aria-label={ariaLabel}
        aria-describedby={unit ? `${id}-unit` : undefined}
        style={unit ? { paddingRight: `calc(${unit.length}ch + 1.25rem)` } : undefined}
        className="tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      {unit && (
        <span
          id={`${id}-unit`}
          className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-muted-foreground text-sm"
        >
          {unit}
        </span>
      )}
    </div>
  );
}
