"use client";

import type { LucideIcon } from "lucide-react";
import { RadioGroup } from "radix-ui";

export type SegmentedOption<T extends string> = { value: T; label: string; icon?: LucideIcon };

// A few mutually exclusive options as one pill, styled like the timeline's
// Cited / All evidence toggle. A radio group underneath: arrow keys move
// between options and screen readers announce the choice. Settings'
// appearance controls use it.
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  "aria-label": label,
  "aria-labelledby": labelledBy,
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: SegmentedOption<T>[];
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={(v) => onValueChange(v as T)}
      aria-label={label}
      aria-labelledby={labelledBy}
      className="inline-flex rounded-md bg-muted p-0.5"
    >
      {options.map(({ value, label, icon: Icon }) => (
        <RadioGroup.Item
          key={value}
          value={value}
          className="flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-muted-foreground text-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=checked]:bg-background data-[state=checked]:text-foreground data-[state=checked]:shadow-sm"
        >
          {Icon && <Icon className="size-3.5" />}
          {label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
