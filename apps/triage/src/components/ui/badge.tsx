import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { LoaderCircleIcon } from "lucide-react"
import { Slot } from "radix-ui"

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        // Tinted variants, for outcomes and states. In light mode the text is
        // the color mixed toward black: red, green, amber and blue text at
        // their own lightness fail contrast on their tint (red came to 4:1).
        destructive:
          "bg-destructive/10 text-[color-mix(in_oklab,var(--destructive)_80%,black)] focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:text-destructive dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
        success:
          "bg-success/10 text-[color-mix(in_oklab,var(--success)_70%,black)] dark:bg-success/20 dark:text-success",
        warning:
          "bg-warning/15 text-[color-mix(in_oklab,var(--warning)_55%,black)] dark:bg-warning/20 dark:text-warning",
        info: "bg-info/10 text-[color-mix(in_oklab,var(--info)_80%,black)] dark:bg-info/20 dark:text-info",
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

// The state colors a status shows, as the dot's color. muted is for a state
// that is neither good nor bad (checking, not running, paused).
const statusTones = {
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  info: "text-info",
  muted: "text-muted-foreground",
} as const

type StatusTone = keyof typeof statusTones

// A status's dot on its own, for where a whole badge won't fit. `pulse`
// ripples a ring out from it, the usual "something is running" signal;
// reduced motion keeps just the dot.
function StatusBadgeDot({
  tone,
  pulse = false,
  className,
}: {
  tone: StatusTone
  pulse?: boolean
  className?: string
}) {
  return (
    <span
      aria-hidden
      data-slot="status-dot"
      className={cn(
        "size-1.5 shrink-0 rounded-full bg-current",
        statusTones[tone],
        pulse &&
          "relative before:absolute before:inset-0 before:animate-ping before:rounded-full before:bg-current motion-reduce:before:animate-none",
        className
      )}
    />
  )
}

// The one way the app shows a status: an outlined badge with a colored dot
// and a label, as in the incident list. `loading` swaps the dot for a
// spinner, for a state still being found out.
function StatusBadge({
  tone,
  loading = false,
  pulse = false,
  className,
  children,
  ...props
}: React.ComponentProps<"span"> & {
  tone: StatusTone
  loading?: boolean
  pulse?: boolean
}) {
  return (
    <Badge variant="outline" className={cn("gap-1.5", className)} {...props}>
      {loading ? (
        <LoaderCircleIcon aria-hidden className="animate-spin text-muted-foreground" />
      ) : (
        <StatusBadgeDot tone={tone} pulse={pulse} />
      )}
      {children}
    </Badge>
  )
}

export { Badge, badgeVariants, StatusBadge, StatusBadgeDot, type StatusTone }
