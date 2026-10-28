"use client";

import { type SegmentedOption, SegmentedControl } from "@/components/ui/segmented-control";
import { useCodeFontSize } from "@/hooks/use-code-font-size";
import type { CodeFontSize } from "@/lib/code-font";

const options: SegmentedOption<CodeFontSize>[] = [
  { value: "small", label: "Small" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large" },
];

// Small, Default, Large for code viewers. The server renders "Default"
// checked; hydration switches it to the saved choice.
export function CodeFontSizeSelect(props: { "aria-label"?: string; "aria-labelledby"?: string }) {
  const { size, setSize } = useCodeFontSize();
  return <SegmentedControl value={size} onValueChange={setSize} options={options} {...props} />;
}
