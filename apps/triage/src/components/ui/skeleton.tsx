import { cn } from "cn"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      // A soft highlight sweeps across while loading; reduced motion keeps
      // the plain block.
      className={cn(
        "relative overflow-hidden rounded-md bg-muted before:absolute before:inset-0 before:animate-shimmer before:bg-linear-to-r before:from-transparent before:via-white/50 before:to-transparent dark:before:via-white/5 motion-reduce:before:hidden",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
