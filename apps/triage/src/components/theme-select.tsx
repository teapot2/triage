"use client";

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { type SegmentedOption, SegmentedControl } from "@/components/ui/segmented-control";
import { useTheme } from "@/hooks/use-theme";
import type { ThemePreference } from "@/lib/theme";

const options: SegmentedOption<ThemePreference>[] = [
  { value: "system", label: "System", icon: MonitorIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
];

// System, Light, Dark. The server renders "System" checked; hydration
// switches it to the saved choice.
export function ThemeSelect(props: { "aria-label"?: string; "aria-labelledby"?: string }) {
  const { preference, setPreference } = useTheme();
  return <SegmentedControl value={preference} onValueChange={setPreference} options={options} {...props} />;
}
