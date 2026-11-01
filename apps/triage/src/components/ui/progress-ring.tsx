import * as React from "react"
import { cn } from "cn"

// A ring that fills clockwise from the top: Progress for tight spots, like
// how full a model's context window got. `value` runs from 0 to 1. Both
// strokes use currentColor (the track faint), so the ring takes its text's
// colour; tint the arc alone with indicatorClassName. With an aria-label it
// is a meter; without one it's decoration beside text that says the value.
function ProgressRing({
  value,
  strokeWidth = 2,
  className,
  indicatorClassName,
  ...props
}: Omit<React.ComponentProps<"svg">, "children"> & {
  value: number
  // In a 16-unit box: 2 is 1/8 of the ring's width at any size.
  strokeWidth?: number
  indicatorClassName?: string
}) {
  const percent = Math.min(Math.max(value, 0), 1) * 100
  const r = 8 - strokeWidth / 2
  const labelled =
    props["aria-label"] !== undefined || props["aria-labelledby"] !== undefined
  return (
    <svg
      data-slot="progress-ring"
      viewBox="0 0 16 16"
      {...(labelled
        ? {
            role: "meter",
            "aria-valuemin": 0,
            "aria-valuemax": 100,
            "aria-valuenow": Math.round(percent),
          }
        : { "aria-hidden": true })}
      className={cn("size-4 shrink-0 -rotate-90", className)}
      {...props}
    >
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        className="opacity-20"
      />
      {/* Nothing at 0; anything above it shows at least a dot, so a sliver
          doesn't read as empty. */}
      {percent > 0 && (
        <circle
          data-slot="progress-ring-indicator"
          cx="8"
          cy="8"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray="100"
          strokeDashoffset={100 - percent}
          className={cn(
            "transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none",
            indicatorClassName
          )}
        />
      )}
    </svg>
  )
}

export { ProgressRing }
