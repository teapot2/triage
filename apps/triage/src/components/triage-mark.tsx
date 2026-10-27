import type { SVGProps } from "react";

// The Triage mark: a crosshair (find the cause) around a check (confirm the
// fix). Drawn for 16px: the crosshair is a ring broken at the four
// cardinal points instead of a ring with ticks, which blur at that size.
// The ring takes the text color; the check is a vivid brand violet
// (--brand-mark; red would read as "problem", as it does everywhere else in
// the app), drawn a little heavier than the ring so the color carries at
// 16px. app/icon.svg is the same drawing with fixed colors.
const ring =
  "M19.61 14.47A8 8 0 0 1 14.47 19.61M9.53 19.61A8 8 0 0 1 4.39 14.47M4.39 9.53A8 8 0 0 1 9.53 4.39M14.47 4.39A8 8 0 0 1 19.61 9.53";
const check = "M8.75 12.25 10.9 14.4 15.25 9.75";

export function TriageMark({
  checkColor = "var(--brand-mark)",
  ...props
}: SVGProps<SVGSVGElement> & {
  // The check's color, a CSS color; the gallery previews brand options.
  checkColor?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth={2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={ring} stroke="currentColor" />
      <path d={check} stroke={checkColor} strokeWidth={2.75} />
    </svg>
  );
}
