"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import {
  CircleCheckIcon,
  CircleXIcon,
  InfoIcon,
  type LucideIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"

// One notice for errors, warnings, successes and information. A variant tints
// the border and background and colors the icon; the title and description
// keep the text colors, since amber or blue text on white fails contrast.
const alertVariants = cva(
  "group/alert relative grid w-full gap-0.5 rounded-lg border px-2.5 py-2 text-left text-sm has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-data-[slot=alert-dismiss]:pr-9 has-data-[slot=alert-action]:has-data-[slot=alert-dismiss]:pr-26 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        destructive:
          "border-destructive/30 bg-destructive/5 text-card-foreground *:[svg]:text-destructive",
        warning:
          "border-warning/40 bg-warning/5 text-card-foreground *:[svg]:text-warning",
        success:
          "border-success/30 bg-success/5 text-card-foreground *:[svg]:text-success",
        info: "border-info/30 bg-info/5 text-card-foreground *:[svg]:text-info",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

type AlertVariant = NonNullable<VariantProps<typeof alertVariants>["variant"]>

// The countdown bar's color for each kind, a step stronger than the tint.
const countdownColors: Record<AlertVariant, string> = {
  default: "bg-foreground/25",
  destructive: "bg-destructive/60",
  warning: "bg-warning/70",
  success: "bg-success/60",
  info: "bg-info/60",
}

// The standard icon for each kind; default has none.
const variantIcons: Record<AlertVariant, LucideIcon | undefined> = {
  default: undefined,
  destructive: CircleXIcon,
  warning: TriangleAlertIcon,
  success: CircleCheckIcon,
  info: InfoIcon,
}

const focusable =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// The first focusable element after `el` in document order, outside it, or
// failing that the last one before it.
function focusNeighbor(el: HTMLElement): HTMLElement | undefined {
  const all = [...document.querySelectorAll<HTMLElement>(focusable)].filter(
    (n) => !el.contains(n) && n.offsetParent !== null
  )
  const after = all.find(
    (n) => el.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING
  )
  return after ?? all.filter((n) => el.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_PRECEDING).at(-1)
}

// Errors interrupt a screen reader (role="alert"); everything else is
// announced politely when it appears (role="status").
function Alert({
  className,
  variant,
  icon,
  role,
  dismissible = false,
  onDismiss,
  dismissLabel = "Dismiss",
  autoDismiss,
  children,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof alertVariants> & {
    // Milliseconds until the notice dismisses itself, shown as a bar along
    // its bottom edge that empties. The countdown pauses while the pointer
    // is over the notice or focus is inside it, so nothing vanishes
    // mid-read. Off by default; meant for confirmations, not errors.
    autoDismiss?: number
    // The variant's icon by default; pass another to replace it, or false
    // for none.
    icon?: React.ReactNode | false
    // Shows an X in the top-right corner that hides the notice. Off by
    // default: errors that still apply shouldn't be dismissible.
    dismissible?: boolean
    // Called when dismissed, so the parent can remember it (for example,
    // not show the notice again). The notice hides itself either way.
    onDismiss?: () => void
    // The X's accessible name, e.g. "Dismiss warning".
    dismissLabel?: string
  }) {
  const [dismissed, setDismissed] = React.useState(false)
  const ref = React.useRef<HTMLDivElement>(null)
  if (dismissed) return null

  const dismiss = () => {
    // If focus is inside (on the X, say), it's about to disappear: hand it
    // to the next focusable element after the notice (or the one before
    // it), so a keyboard user keeps their place instead of landing on
    // <body>. Focus elsewhere, as when the countdown runs out, stays put.
    const el = ref.current
    const next = el && el.contains(document.activeElement) ? focusNeighbor(el) : undefined
    setDismissed(true)
    onDismiss?.()
    requestAnimationFrame(() => next?.focus())
  }

  const Icon = variantIcons[variant ?? "default"]
  const shownIcon = icon === undefined ? Icon && <Icon /> : icon
  const seconds = autoDismiss !== undefined ? Math.round(autoDismiss / 1000) : 0
  return (
    <div
      ref={ref}
      data-slot="alert"
      role={role ?? (variant === "destructive" ? "alert" : "status")}
      className={cn(alertVariants({ variant }), autoDismiss !== undefined && "overflow-hidden", className)}
      {...props}
    >
      {shownIcon || null}
      {children}
      {autoDismiss !== undefined && (
        <>
          <span className="sr-only">
            Closes after {seconds} {seconds === 1 ? "second" : "seconds"}.
          </span>
          {/* The countdown is the bar's own animation: pausing it (hover,
              focus) pauses the timer, and its end dismisses the notice.
              With reduced motion it steps down instead of sliding. */}
          <span
            aria-hidden
            data-slot="alert-countdown"
            style={{ animationDuration: `${autoDismiss}ms` }}
            onAnimationEnd={dismiss}
            className={cn(
              "absolute inset-x-0 bottom-0 h-0.5 origin-left animate-countdown group-focus-within/alert:[animation-play-state:paused] group-hover/alert:[animation-play-state:paused] motion-reduce:[animation-timing-function:steps(5,end)]",
              countdownColors[variant ?? "default"]
            )}
          />
        </>
      )}
      {dismissible && (
        <Button
          data-slot="alert-dismiss"
          variant="ghost"
          size="icon-xs"
          aria-label={dismissLabel}
          onClick={dismiss}
          className="absolute top-1.5 right-1.5 text-muted-foreground hover:text-foreground"
        >
          <XIcon />
        </Button>
      )}
    </div>
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-sm text-balance text-muted-foreground md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
        className
      )}
      {...props}
    />
  )
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn(
        "absolute top-2 right-2 group-has-data-[slot=alert-dismiss]/alert:right-9",
        className
      )}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription, AlertAction }
