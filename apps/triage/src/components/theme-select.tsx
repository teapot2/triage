"use client";

import { type LucideIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { RadioGroup } from "radix-ui";
import { useTheme } from "@/hooks/use-theme";
import type { ThemePreference } from "@/lib/theme";

const options: { value: ThemePreference; label: string; icon: LucideIcon }[] = [
  { value: "system", label: "System", icon: MonitorIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
];

// System, Light, Dark as a segmented control, styled like the timeline's
// Cited / All evidence toggle. A radio group underneath: arrow keys move
// between options and screen readers announce the choice. The server
// renders "System" checked; hydration switches it to the saved choice.
export function ThemeSelect({
  "aria-label": label,
  "aria-labelledby": labelledBy,
}: {
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  const { preference, setPreference } = useTheme();
  return (
    <RadioGroup.Root
      value={preference}
      onValueChange={(v) => setPreference(v as ThemePreference)}
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
          <Icon className="size-3.5" />
          {label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
