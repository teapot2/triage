import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// The pieces the Watch forms (rules and endpoints) lay their fields out with.

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

// A labelled field, with a hint under it, or the error in its place. `wide`
// spans both columns.
export function FormField({
  label,
  htmlFor,
  hint,
  error,
  wide,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", wide && "sm:col-span-2")}>
      <label htmlFor={htmlFor} className="font-medium text-xs">
        {label}
      </label>
      {children}
      {error ? (
        <span role="alert" className="text-[color-mix(in_oklab,var(--destructive)_80%,black)] text-xs dark:text-destructive">
          {error}
        </span>
      ) : (
        hint && <span className="text-muted-foreground text-xs">{hint}</span>
      )}
    </div>
  );
}

// A number filling its cell, its unit shown inside at the right end. The
// browser's spin buttons are hidden; they'd sit on top of the unit.
export function NumberInput({
  id,
  unit,
  value,
  onChange,
  invalid,
}: {
  id: string;
  unit: string;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
}) {
  return (
    <div className="relative">
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid}
        aria-describedby={`${id}-unit`}
        style={{ paddingRight: `calc(${unit.length}ch + 1.25rem)` }}
        className="tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <span
        id={`${id}-unit`}
        className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-muted-foreground text-sm"
      >
        {unit}
      </span>
    </div>
  );
}
